import { formatAge } from './cloudflare-drift.mjs';

// Read-only access to the Cloudflare v4 API for `npm run verify:cloudflare`. Every request is a GET; the module
// has no way to issue another method. Error messages name the account as `{account}` and never carry the token.
export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const MAX_PAGES = 50;
// Cloudflare reports some authentication and authorization failures in the envelope rather than the HTTP status.
const ACCESS_ERROR_CODES = new Set([9106, 9109, 10000, 10001]);

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function requireCredentials(env) {
  const token = env.CLOUDFLARE_API_TOKEN ?? '';
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? '';
  const missing = [['CLOUDFLARE_API_TOKEN', token], ['CLOUDFLARE_ACCOUNT_ID', accountId]].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw failure('CLOUDFLARE_CREDENTIALS_REQUIRED', `${missing.join(' and ')} must be set; nothing was read`);
  if (!ACCOUNT_ID.test(accountId)) {
    throw failure('CLOUDFLARE_CREDENTIALS_REQUIRED', 'CLOUDFLARE_ACCOUNT_ID must be a 32-character lowercase hex account ID; nothing was read');
  }
  return { token, accountId };
}

const describeErrors = (body) => (Array.isArray(body?.errors) ? body.errors : [])
  .map((error) => `${error.code}: ${String(error.message ?? '').slice(0, 200)}`).join('; ');

// One GET against an account-scoped path such as `/workers/scripts`. Returns the parsed envelope.
export async function cloudflareGet(path, { token, accountId, fetchImpl = fetch }) {
  const shown = `GET /accounts/{account}${path}`;
  let response;
  try {
    response = await fetchImpl(`${CLOUDFLARE_API}/accounts/${accountId}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'user-agent': 'baseline-verify-cloudflare' },
    });
  } catch (error) {
    throw failure('CLOUDFLARE_API_FAILED', `Cloudflare ${shown} could not be reached: ${error.message}`);
  }
  const body = await response.json().catch(() => null);
  const accessError = (body?.errors ?? []).some((error) => ACCESS_ERROR_CODES.has(error.code));
  if (response.status === 401 || response.status === 403 || accessError) {
    throw failure('CLOUDFLARE_READ_INACCESSIBLE', `Cloudflare ${shown} needs read access (HTTP ${response.status}${describeErrors(body) ? `; ${describeErrors(body)}` : ''})`);
  }
  if (!response.ok || body?.success !== true) {
    throw failure('CLOUDFLARE_API_FAILED', `Cloudflare ${shown} failed (HTTP ${response.status}${describeErrors(body) ? `; ${describeErrors(body)}` : ''})`);
  }
  return body;
}

// Follows cursor or page pagination when the envelope reports more results. The first request carries no paging
// parameters, so a single-page account issues exactly one GET per list.
export async function cloudflareList(path, options, pick = (result) => result) {
  const items = [];
  let query = '';
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await cloudflareGet(`${path}${query}`, options);
    const batch = pick(body.result) ?? [];
    if (!Array.isArray(batch)) throw failure('CLOUDFLARE_API_FAILED', `Cloudflare GET /accounts/{account}${path} returned an unexpected shape`);
    items.push(...batch);
    const info = body.result_info ?? {};
    const join = path.includes('?') ? '&' : '?';
    if (info.cursor) query = `${join}cursor=${encodeURIComponent(info.cursor)}`;
    else if (batch.length && ((info.total_pages ?? 0) > (info.page ?? page) || (info.total_count ?? 0) > items.length)) {
      query = `${join}page=${(info.page ?? page) + 1}${info.per_page ? `&per_page=${info.per_page}` : ''}`;
    } else return items;
  }
  throw failure('CLOUDFLARE_API_FAILED', `Cloudflare GET /accounts/{account}${path} exceeded ${MAX_PAGES} pages`);
}

const scopeOf = (prefix) => prefix || '(all objects)';
const when = (condition) => (condition?.type === 'Age' ? `after ${formatAge(condition.maxAge)}` : `on ${condition?.date ?? 'unknown'}`);

// Reduces R2 lifecycle rules to one canonical line per transition, matching `expectedCloudflareState`.
export function normalizeLifecycle(rules) {
  const lines = [];
  for (const rule of rules ?? []) {
    const scope = scopeOf(rule.conditions?.prefix ?? '');
    const suffix = rule.enabled === false ? ' [disabled]' : '';
    const abort = rule.abortMultipartUploadsTransition?.condition;
    const expire = rule.deleteObjectsTransition?.condition;
    if (abort) lines.push(`abort incomplete multipart uploads ${scope} ${when(abort)}${suffix}`);
    if (expire) lines.push(`expire ${scope} ${when(expire)}${suffix}`);
    for (const transition of rule.storageClassTransitions ?? []) {
      lines.push(`transition ${scope} to ${transition.storageClass} ${when(transition.condition)}${suffix}`);
    }
  }
  return lines;
}

const encode = (name) => encodeURIComponent(name);

export async function fetchLiveCloudflareState(desired, options) {
  const scripts = await cloudflareList('/workers/scripts', options);
  const workers = scripts.map((script) => script.id);
  const domains = {};
  for (const domain of await cloudflareList('/workers/domains', options)) {
    domains[domain.hostname] = { worker: domain.service, enabled: domain.enabled !== false };
  }

  const crons = [];
  const secrets = [];
  const settings = {};
  for (const name of workers) {
    const schedules = (await cloudflareGet(`/workers/scripts/${encode(name)}/schedules`, options)).result?.schedules ?? [];
    crons.push(...schedules.map((schedule) => `${name}: ${schedule.cron}`));
    secrets.push(...(await cloudflareList(`/workers/scripts/${encode(name)}/secrets`, options)).map((secret) => `${name}:${secret.name}`));
    if (!Object.hasOwn(desired.workers, name)) continue;
    const config = (await cloudflareGet(`/workers/scripts/${encode(name)}/settings`, options)).result ?? {};
    const subdomain = (await cloudflareGet(`/workers/scripts/${encode(name)}/subdomain`, options)).result ?? {};
    settings[name] = {
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags ?? [],
      observability: config.observability?.enabled === true,
      workersDev: subdomain.enabled === true,
      previewUrls: subdomain.previews_enabled === true,
    };
  }

  const d1 = (await cloudflareList('/d1/database', options)).map((database) => database.name);
  const r2 = (await cloudflareList('/r2/buckets', options, (result) => result?.buckets)).map((bucket) => bucket.name);
  const lifecycle = {};
  for (const bucket of desired.r2.map((entry) => entry.name).filter((name) => r2.includes(name))) {
    lifecycle[bucket] = normalizeLifecycle((await cloudflareGet(`/r2/buckets/${encode(bucket)}/lifecycle`, options)).result?.rules);
  }
  const kv = (await cloudflareList('/storage/kv/namespaces', options)).map((namespace) => namespace.title);
  const durableObjects = (await cloudflareList('/workers/durable_objects/namespaces', options))
    .map((namespace) => `${namespace.script}:${namespace.class}`);

  const secretsStores = [];
  const secretsStoreSecrets = [];
  for (const store of await cloudflareList('/secrets_store/stores', options)) {
    secretsStores.push(store.name);
    for (const secret of await cloudflareList(`/secrets_store/stores/${encode(store.id)}/secrets`, options)) {
      secretsStoreSecrets.push(`${store.name}:${secret.name}`);
    }
  }
  return { workers, domains, d1, r2, kv, durableObjects, crons, secrets, secretsStores, secretsStoreSecrets, settings, lifecycle };
}
