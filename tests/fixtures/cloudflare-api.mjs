import { readFileSync } from 'node:fs';
import { CLOUDFLARE_API } from '../../scripts/cloudflare-live-state.mjs';

export const ACCOUNT_ID = 'f'.repeat(32);
export const TOKEN = 'cf-test-token-must-never-print';
export const ENV = Object.freeze({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID });

const ok = (result, extra = {}) => ({ status: 200, body: { success: true, errors: [], messages: [], result, ...extra } });

export function recordedResponses(date) {
  return JSON.parse(readFileSync(new URL(`cloudflare-${date}.json`, import.meta.url), 'utf8')).responses;
}

// The API responses of an account that exactly matches the desired state.
export function convergedResponses(desired) {
  const responses = {};
  const workers = Object.entries(desired.workers);
  responses['/workers/scripts'] = ok(workers.map(([name]) => ({ id: name })));
  responses['/workers/domains'] = ok(workers.flatMap(([name, worker]) => [worker.host, ...worker.aliases]
    .map((hostname) => ({ hostname, service: name, environment: 'production', zone_name: desired.zone, enabled: true }))));
  for (const [name, worker] of workers) {
    responses[`/workers/scripts/${name}/settings`] = ok({
      compatibility_date: desired.compatibility.date,
      compatibility_flags: [...desired.compatibility.flags],
      observability: { enabled: true, head_sampling_rate: 1 },
      bindings: [],
    });
    responses[`/workers/scripts/${name}/secrets`] = ok(worker.secrets.map((secret) => ({ name: secret, type: 'secret_text' })));
    responses[`/workers/scripts/${name}/subdomain`] = ok({ enabled: false, previews_enabled: false });
    responses[`/workers/scripts/${name}/schedules`] = ok({ schedules: worker.crons.map((cron) => ({ cron })) });
  }
  responses['/d1/database'] = ok(desired.d1.map((name) => ({ uuid: `d1-${name}`, name })));
  responses['/r2/buckets'] = ok({ buckets: desired.r2.map((bucket) => ({ name: bucket.name })) });
  for (const bucket of desired.r2) {
    const day = 86400;
    responses[`/r2/buckets/${bucket.name}/lifecycle`] = ok({
      rules: [
        { id: 'abort-multipart', enabled: true, conditions: {},
          abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: bucket.abortIncompleteMultipartUploadDays * day } } },
        ...Object.values(bucket.prefixes).flatMap((entry) => entry.expiry.map((rule) => ({
          id: `expire-${rule.prefix}`, enabled: true, conditions: { prefix: rule.prefix },
          deleteObjectsTransition: { condition: { type: 'Age', maxAge: rule.days * day } },
        }))),
      ],
    });
  }
  responses['/storage/kv/namespaces'] = ok(desired.kv.map((title) => ({ id: `kv-${title}`, title })));
  responses['/workers/durable_objects/namespaces'] = ok(workers.flatMap(([name, worker]) => worker.durableObjects
    .map((cls) => ({ id: `do-${name}-${cls}`, name: `${name}_${cls}`, script: name, class: cls, use_sqlite: true }))));
  responses['/secrets_store/stores'] = ok(desired.secretsStore.map((store) => ({ id: `store-${store.name}`, name: store.name })));
  for (const store of desired.secretsStore) {
    responses[`/secrets_store/stores/store-${store.name}/secrets`] = ok(store.secrets.map((name) => ({ name })));
  }
  return responses;
}

// A fetch stand-in that serves account-relative paths from `responses`, records every call and refuses anything
// but an authenticated GET for the expected account.
export function fakeFetch(responses, calls = []) {
  const prefix = `${CLOUDFLARE_API}/accounts/${ACCOUNT_ID}`;
  return async (url, init) => {
    calls.push({ url, method: init?.method, authorization: init?.headers?.authorization });
    if (init?.method !== 'GET') throw new Error(`non-GET request ${init?.method} ${url}`);
    if (!url.startsWith(prefix)) throw new Error(`request outside the account: ${url}`);
    const entry = typeof responses === 'function' ? responses(url.slice(prefix.length)) : responses[url.slice(prefix.length)];
    const { status, body } = entry ?? { status: 404, body: { success: false, errors: [{ code: 7003, message: 'Not found' }] } };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
}
