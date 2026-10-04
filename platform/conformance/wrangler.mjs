// Worker config conformance. A consumer's wrangler config is one top-level Worker that matches its declared
// entry in baseline config/cloudflare.json: its own name and host, the shared settings, and only the shared bindings.
import { DESIRED } from './desired.mjs';
import { parseJsonc } from './jsonc.mjs';

const ALLOWED_KEYS = new Set([
  '$schema', 'name', 'main', 'compatibility_date', 'compatibility_flags', 'workers_dev', 'preview_urls', 'routes',
  'observability', 'vars', 'assets', 'd1_databases', 'r2_buckets', 'durable_objects', 'migrations', 'triggers',
  'secrets_store_secrets', 'upload_source_maps',
]);
const REQUIRED_KEYS = ['name', 'main', 'compatibility_date', 'compatibility_flags', 'workers_dev', 'preview_urls',
  'routes', 'observability', 'vars'];
const FORBIDDEN_REASONS = {
  env: 'environment blocks are not allowed; the top-level config is the production Worker',
  account_id: 'the account ID is never committed; deploys read CLOUDFLARE_ACCOUNT_ID',
  kv_namespaces: 'KV is not part of the platform; use WG_DB records or WG_R2',
  route: 'use routes with exactly one custom domain',
};
const ASSET_KEYS = ['directory', 'binding', 'run_worker_first', 'not_found_handling', 'html_handling'];
const MIGRATION_STEPS = ['new_classes', 'new_sqlite_classes', 'deleted_classes', 'renamed_classes', 'transferred_classes'];
const STORE_ID = /^[0-9a-f]{32}$/;
const DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameSet = (actual, expected) => new Set(actual).size === actual.length
  && actual.length === expected.length && expected.every((entry) => actual.includes(entry));
const show = (value) => JSON.stringify(value);

function exactKeys(failures, label, value, required, optional = []) {
  if (!isObject(value)) return failures.push(`${label} must be an object`) && false;
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) failures.push(`${label}.${key} is not allowed`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) failures.push(`${label}.${key} is required`);
  return true;
}

function checkRoutes(failures, routes, worker) {
  const allowed = [worker.host, ...worker.aliases];
  if (!Array.isArray(routes)) return failures.push('routes must be an array of custom domains');
  routes.forEach((route, index) => {
    if (!exactKeys(failures, `routes[${index}]`, route, ['pattern', 'custom_domain'])) return;
    if (route.custom_domain !== true) failures.push(`routes[${index}] must be a custom domain, not a zone route`);
    if (!allowed.includes(route.pattern)) failures.push(`routes[${index}] ${show(route.pattern)} is not this Worker's declared host`);
  });
  const patterns = routes.map((route) => route?.pattern);
  if (patterns.filter((pattern) => pattern === worker.host).length !== 1) {
    failures.push(`routes must contain the declared host ${worker.host} exactly once`);
  }
  if (new Set(patterns).size !== patterns.length) failures.push('routes must not repeat a host');
}

function checkVars(failures, vars, name, secrets) {
  if (!isObject(vars)) return failures.push('vars must be an object with WG_APP');
  if (vars.WG_APP !== name) failures.push(`vars.WG_APP must equal the Worker name ${show(name)}`);
  for (const [key, value] of Object.entries(vars)) {
    if (typeof value !== 'string') failures.push(`vars.${key} must be a string`);
    if (key !== 'WG_APP' && key.startsWith('WG_')) failures.push(`vars.${key} is reserved for platform bindings`);
    if (secrets.includes(key)) failures.push(`vars.${key} is a secret and must never be a plain-text var`);
  }
}

function checkSingleBinding(failures, key, value, binding, nameKey, name, idKey, idPattern) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length !== 1) return failures.push(`${key} must hold exactly one ${binding} binding`);
  const entry = value[0];
  if (!exactKeys(failures, `${key}[0]`, entry, ['binding', nameKey], idKey ? [idKey] : [])) return;
  if (entry.binding !== binding) failures.push(`${key}[0].binding must be ${binding}`);
  if (entry[nameKey] !== name) failures.push(`${key}[0].${nameKey} must be ${name}`);
  if (idKey && Object.hasOwn(entry, idKey) && !idPattern.test(entry[idKey])) failures.push(`${key}[0].${idKey} is malformed`);
}

// The net Durable Object classes after replaying every migration step in order.
function replayMigrations(failures, migrations) {
  const live = new Set();
  if (migrations === undefined) return live;
  if (!Array.isArray(migrations)) return failures.push('migrations must be an array') && live;
  migrations.forEach((step, index) => {
    const label = `migrations[${index}]`;
    if (!exactKeys(failures, label, step, ['tag'], MIGRATION_STEPS)) return;
    for (const name of [...(step.new_classes ?? []), ...(step.new_sqlite_classes ?? [])]) live.add(name);
    for (const name of step.deleted_classes ?? []) {
      if (!live.delete(name)) failures.push(`${label} deletes ${show(name)}, which no earlier step created`);
    }
    for (const rename of step.renamed_classes ?? []) {
      if (!live.delete(rename?.from)) failures.push(`${label} renames ${show(rename?.from)}, which no earlier step created`);
      live.add(rename?.to);
    }
    for (const transfer of step.transferred_classes ?? []) live.add(transfer?.to);
  });
  return live;
}

function checkDurableObjects(failures, config, declared) {
  const bindings = config.durable_objects === undefined ? [] : config.durable_objects?.bindings;
  if (config.durable_objects !== undefined) exactKeys(failures, 'durable_objects', config.durable_objects, ['bindings']);
  if (!Array.isArray(bindings)) return failures.push('durable_objects.bindings must be an array');
  bindings.forEach((binding, index) => exactKeys(failures, `durable_objects.bindings[${index}]`, binding, ['name', 'class_name']));
  const bound = bindings.map((binding) => binding?.class_name);
  if (!sameSet(bound, [...declared])) failures.push(`Durable Object bindings ${show(bound)} must be exactly the declared classes ${show(declared)}`);
  const live = [...replayMigrations(failures, config.migrations)];
  if (!sameSet(live, [...declared])) failures.push(`migrations leave classes ${show(live)}; the declared classes are ${show(declared)}`);
}

function checkTriggers(failures, triggers, declared) {
  if (triggers === undefined) {
    if (declared.length) failures.push(`triggers.crons must be exactly ${show(declared)}`);
    return;
  }
  if (!exactKeys(failures, 'triggers', triggers, ['crons'])) return;
  if (!Array.isArray(triggers.crons) || !sameSet(triggers.crons, [...declared])) {
    failures.push(`triggers.crons must be exactly ${show(declared)}`);
  }
}

function checkSecretsStore(failures, value, allowed) {
  if (value === undefined) return;
  if (!Array.isArray(value)) return failures.push('secrets_store_secrets must be an array');
  const seen = new Set();
  value.forEach((entry, index) => {
    const label = `secrets_store_secrets[${index}]`;
    if (!exactKeys(failures, label, entry, ['binding', 'store_id', 'secret_name'])) return;
    if (!allowed.includes(entry.binding)) failures.push(`${label} binds ${show(entry.binding)}; only ${allowed.join(' and ')} are declared`);
    if (entry.secret_name !== entry.binding) failures.push(`${label}.secret_name must equal its binding`);
    if (!STORE_ID.test(entry.store_id ?? '')) failures.push(`${label}.store_id is malformed`);
    if (seen.has(entry.binding)) failures.push(`${label} repeats ${entry.binding}`);
    seen.add(entry.binding);
  });
}

/**
 * Check a parsed wrangler config against one Worker's declared entry.
 * @param {unknown} config the parsed wrangler.jsonc
 * @param {{ label: string, worker: { host: string, aliases: readonly string[], durableObjects: readonly string[], crons: readonly string[], secrets?: readonly string[] }, shared?: typeof DESIRED }} target
 * @returns {string[]} failures; empty means conformant
 */
export function checkWranglerConfig(config, { label, worker, shared = DESIRED }) {
  const failures = [];
  if (!isObject(config)) return ['the wrangler config must be a JSON object'];
  for (const key of Object.keys(config)) {
    if (Object.hasOwn(FORBIDDEN_REASONS, key)) failures.push(`${key}: ${FORBIDDEN_REASONS[key]}`);
    else if (!ALLOWED_KEYS.has(key)) failures.push(`${key} is not an allowed top-level key`);
  }
  for (const key of REQUIRED_KEYS) if (!Object.hasOwn(config, key)) failures.push(`${key} is required`);
  if (config.name !== label) failures.push(`name must equal the Worker label ${show(label)}`);
  if (typeof config.main !== 'string' || !config.main) failures.push('main must name the Worker entry module');
  if (config.compatibility_date !== shared.compatibility.date) failures.push(`compatibility_date must be ${shared.compatibility.date}`);
  if (!Array.isArray(config.compatibility_flags) || !sameSet(config.compatibility_flags, [...shared.compatibility.flags])) {
    failures.push(`compatibility_flags must be exactly ${show(shared.compatibility.flags)}`);
  }
  if (config.workers_dev !== shared.workerSettings.workersDev) failures.push(`workers_dev must be ${shared.workerSettings.workersDev}`);
  if (config.preview_urls !== shared.workerSettings.previewUrls) failures.push(`preview_urls must be ${shared.workerSettings.previewUrls}`);
  if (!isObject(config.observability) || config.observability.enabled !== shared.workerSettings.observability) {
    failures.push(`observability.enabled must be ${shared.workerSettings.observability}`);
  }
  if (config.routes !== undefined) checkRoutes(failures, config.routes, worker);
  // Every registry Worker secret is refused as a var on every Worker, not only on its consumers: a key such as
  // GITHUB_APP_PRIVATE_KEY must never land in plain text in any wrangler config.
  const registrySecrets = Object.values(shared.workers).flatMap((entry) => entry.secrets ?? []);
  checkVars(failures, config.vars, label, [...shared.secretsStoreSecrets, ...(worker.secrets ?? []), ...registrySecrets]);
  if (config.assets !== undefined && exactKeys(failures, 'assets', config.assets, ['directory'], ASSET_KEYS.slice(1))
    && config.assets.binding !== undefined && config.assets.binding !== 'ASSETS') failures.push('assets.binding must be ASSETS');
  checkSingleBinding(failures, 'd1_databases', config.d1_databases, shared.d1.binding, 'database_name', shared.d1.name, 'database_id', DATABASE_ID);
  checkSingleBinding(failures, 'r2_buckets', config.r2_buckets, shared.r2.binding, 'bucket_name', shared.r2.name);
  checkDurableObjects(failures, config, worker.durableObjects);
  checkTriggers(failures, config.triggers, worker.crons);
  checkSecretsStore(failures, config.secrets_store_secrets, shared.secretsStoreSecrets);
  if (config.upload_source_maps !== undefined && typeof config.upload_source_maps !== 'boolean') failures.push('upload_source_maps must be a boolean');
  return failures;
}

/**
 * Check wrangler.jsonc source text for the named Worker in the vendored desired state.
 * @param {string} source @param {string} label
 */
export function checkWranglerSource(source, label, shared = DESIRED) {
  if (!Object.hasOwn(shared.workers, label)) return [`${show(label)} is not a declared Worker`];
  let config;
  try {
    config = parseJsonc(source);
  } catch (error) {
    return [`the wrangler config is not valid JSONC: ${error.message}`];
  }
  return checkWranglerConfig(config, { label, worker: shared.workers[label], shared });
}
