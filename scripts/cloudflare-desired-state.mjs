import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The closed Cloudflare consolidation policy. `config/cloudflare.json` declares the desired state; this module
// rejects anything outside it. Changing one of these sets is a controlled change to the module and the config together.
export const ZONE = 'wizardgang.ai';
export const WORKERS = Object.freeze(['wizardgang', 'demo', 'sharktank', 'hexframe']);
export const APEX_WORKER = 'wizardgang';
export const ENVIRONMENT = 'production';
export const ALIASES = Object.freeze({ wizardgang: Object.freeze(['www.wizardgang.ai']) });
export const DURABLE_OBJECTS = Object.freeze({ demo: Object.freeze(['DemoCoordinator']), sharktank: Object.freeze(['Room']) });
export const CRONS = Object.freeze({ demo: Object.freeze(['*/5 * * * *']) });
export const D1_DATABASE = 'wizardgang';
export const R2_BUCKET = 'wizardgang';
export const SECRETS_STORE_SECRETS = Object.freeze(['WG_OPS_TOKEN', 'WG_SESSION_KEY']);
export const COMPATIBILITY_FLAGS = Object.freeze(['nodejs_compat']);
// The newest compatibility date live on any Worker when the desired state was declared (2026-10-03 read).
export const MINIMUM_COMPATIBILITY_DATE = '2026-08-31';

const TOP_LEVEL_KEYS = ['schemaVersion', 'zone', 'compatibility', 'workerSettings', 'routes', 'workers', 'd1', 'r2', 'kv', 'secretsStore'];
const WORKER_KEYS = ['repository', 'environment', 'host', 'aliases', 'durableObjects', 'crons', 'secrets'];
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
// Admin credentials belong to the shared shell's operator gate (`WG_OPS_TOKEN`), never to a Worker.
const ADMIN_SECRET = /(?:^|_)ADMIN_|^OPS_/;
const ACCOUNT_ID_KEY = /^account[_-]?id$/i;
const RESOURCE_ID_KEY = /^(?:id|ID|uuid)$|_(?:id|ID)$|[a-z]Id$/;
const SECRET_VALUE_KEY = /^(?:value|values|secret_?value|text|plaintext|token|password)$/i;
const HEX_ID = /(?:^|[^0-9a-f])[0-9a-f]{32}(?:$|[^0-9a-f])/i;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameSet = (actual, expected) => actual.length === expected.length && expected.every((entry) => actual.includes(entry));
const isWholeNumber = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

// Account IDs, binding IDs and secret values never belong in the committed desired state.
function scanForCommittedValues(value, path, failures) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForCommittedValues(entry, `${path}[${index}]`, failures));
  } else if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (ACCOUNT_ID_KEY.test(key)) failures.push(`${path}.${key}: a committed account ID is not allowed`);
      else if (RESOURCE_ID_KEY.test(key)) failures.push(`${path}.${key}: a committed resource or binding ID is not allowed`);
      if (SECRET_VALUE_KEY.test(key)) failures.push(`${path}.${key}: a secret value field is not allowed`);
      scanForCommittedValues(entry, `${path}.${key}`, failures);
    }
  } else if (typeof value === 'string' && HEX_ID.test(value)) {
    failures.push(`${path}: looks like a committed account or resource ID`);
  }
}

// Reports unknown and missing keys; returns whether `value` is an object worth inspecting further.
function closed(failures, label, value, keys) {
  if (!isObject(value)) {
    failures.push(`${label} must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) if (!keys.includes(key)) failures.push(`${label}: unknown key ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) failures.push(`${label}: missing key ${key}`);
  return true;
}

function names(failures, label, value, pattern, entryMessage = `${label} entries must be strings`) {
  if (!Array.isArray(value)) {
    failures.push(`${label} must be a list`);
    return [];
  }
  const seen = [];
  for (const entry of value) {
    if (typeof entry !== 'string') failures.push(entryMessage);
    else if (!pattern.test(entry)) failures.push(`${label}: invalid entry ${JSON.stringify(entry)}`);
    else if (seen.includes(entry)) failures.push(`${label}: duplicate entry ${entry}`);
    else seen.push(entry);
  }
  return seen;
}

function requireExactly(failures, label, actual, expected, noun) {
  for (const entry of actual) if (!expected.includes(entry)) failures.push(`${label}: undeclared ${noun} ${entry}`);
  for (const entry of expected) if (!actual.includes(entry)) failures.push(`${label}: missing ${noun} ${entry}`);
}

function validateWorker(failures, name, worker, hosts, repositories) {
  const label = `workers.${name}`;
  if (!closed(failures, label, worker, WORKER_KEYS)) return;
  const { repository } = worker;
  if (typeof repository !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
    failures.push(`${label}: repository must be an owner/name GitHub repository`);
  } else if (repositories.has(repository)) {
    failures.push(`${label}: repository ${repository} already owns Worker ${repositories.get(repository)}`);
  } else {
    repositories.set(repository, name);
  }
  if (worker.environment !== ENVIRONMENT) failures.push(`${label}: environment must be ${ENVIRONMENT}`);

  const expectedHost = name === APEX_WORKER ? ZONE : `${name}.${ZONE}`;
  if (worker.host !== expectedHost) failures.push(`${label}: host must be ${expectedHost}`);
  const aliases = names(failures, `${label}.aliases`, worker.aliases, /^[a-z0-9.-]+$/);
  const expectedAliases = ALIASES[name] ?? [];
  if (!sameSet(aliases, expectedAliases)) {
    failures.push(`${label}: aliases must be ${expectedAliases.length ? expectedAliases.join(', ') : 'empty'}`);
  }
  for (const host of [worker.host, ...aliases]) {
    if (typeof host !== 'string') continue;
    if (hosts.has(host)) failures.push(`${label}: duplicate host ${host} already served by ${hosts.get(host)}`);
    else hosts.set(host, name);
  }

  const classes = names(failures, `${label}.durableObjects`, worker.durableObjects, /^[A-Z][A-Za-z0-9]*$/);
  requireExactly(failures, label, classes.map((cls) => `${name}:${cls}`),
    (DURABLE_OBJECTS[name] ?? []).map((cls) => `${name}:${cls}`), 'Durable Object class');
  const crons = names(failures, `${label}.crons`, worker.crons, /^\S+(?: \S+){4}$/);
  requireExactly(failures, label, crons, CRONS[name] ?? [], 'cron');

  const secrets = names(failures, `${label}.secrets`, worker.secrets, SECRET_NAME,
    `${label}.secrets: entries are secret names only; secret values are never committed`);
  if (secrets.join('\n') !== [...secrets].sort().join('\n')) failures.push(`${label}.secrets must be sorted`);
  for (const secret of secrets) {
    if (SECRETS_STORE_SECRETS.includes(secret) || secret.startsWith('WG_')) {
      failures.push(`${label}.secrets: ${secret} is reserved for the Secrets Store`);
    }
    if (ADMIN_SECRET.test(secret)) failures.push(`${label}.secrets: ${secret} is an admin credential; the shell operator gate owns admin auth`);
  }
}

function validateBucket(failures, bucket) {
  if (!closed(failures, 'r2[0]', bucket, ['name', 'abortIncompleteMultipartUploadDays', 'prefixes'])) return;
  if (bucket.name !== R2_BUCKET) failures.push(`r2[0]: bucket must be named ${R2_BUCKET}`);
  if (!isWholeNumber(bucket.abortIncompleteMultipartUploadDays, 1, 30)) {
    failures.push('r2[0]: abortIncompleteMultipartUploadDays must be a whole number from 1 to 30');
  }
  if (!closed(failures, 'r2[0].prefixes', bucket.prefixes, WORKERS)) return;
  for (const worker of WORKERS) {
    const label = `r2[0].prefixes.${worker}`;
    const entry = bucket.prefixes[worker];
    if (!closed(failures, label, entry, ['prefix', 'expiry'])) continue;
    if (entry.prefix !== `${worker}/`) failures.push(`${label}: prefix must be ${worker}/`);
    if (!Array.isArray(entry.expiry)) {
      failures.push(`${label}.expiry must be a list`);
      continue;
    }
    const seen = new Set();
    entry.expiry.forEach((rule, index) => {
      const ruleLabel = `${label}.expiry[${index}]`;
      if (!closed(failures, ruleLabel, rule, ['prefix', 'days'])) return;
      if (typeof rule.prefix !== 'string' || !rule.prefix.startsWith(`${worker}/`) || rule.prefix === `${worker}/` || !rule.prefix.endsWith('/')) {
        failures.push(`${ruleLabel}: prefix must be a folder under ${worker}/`);
      } else if (seen.has(rule.prefix)) {
        failures.push(`${ruleLabel}: duplicate expiry prefix ${rule.prefix}`);
      } else {
        seen.add(rule.prefix);
      }
      if (!isWholeNumber(rule.days, 1, 3650)) failures.push(`${ruleLabel}: days must be a whole number from 1 to 3650`);
    });
  }
}

function validateStore(failures, store) {
  if (!closed(failures, 'secretsStore[0]', store, ['name', 'secrets'])) return;
  if (typeof store.name !== 'string' || !/^[a-z0-9_-]+$/.test(store.name)) failures.push('secretsStore[0]: name must be a store name');
  const secrets = names(failures, 'secretsStore[0].secrets', store.secrets, SECRET_NAME,
    'secretsStore[0].secrets: entries are secret names only; secret values are never committed');
  requireExactly(failures, 'secretsStore[0]', secrets, SECRETS_STORE_SECRETS, 'secret');
}

function exactlyOne(failures, label, value, noun) {
  if (!Array.isArray(value)) {
    failures.push(`${label} must be a list`);
    return false;
  }
  if (value.length !== 1) failures.push(`${label}: exactly one ${noun} is allowed, found ${value.length}`);
  return value.length >= 1;
}

export function validateCloudflareDesiredState(state) {
  const failures = [];
  scanForCommittedValues(state, 'cloudflare', failures);
  if (!closed(failures, 'cloudflare', state, TOP_LEVEL_KEYS)) return failures;
  if (state.schemaVersion !== 1) failures.push('cloudflare: schemaVersion must be 1');
  if (state.zone !== ZONE) failures.push(`cloudflare: zone must be ${ZONE}`);

  if (closed(failures, 'compatibility', state.compatibility, ['date', 'flags'])) {
    const { date, flags } = state.compatibility;
    if (!isCalendarDate(date)) failures.push('compatibility: date must be a YYYY-MM-DD calendar date');
    else if (date < MINIMUM_COMPATIBILITY_DATE) failures.push(`compatibility: date must be ${MINIMUM_COMPATIBILITY_DATE} or later`);
    if (!Array.isArray(flags) || flags.length !== COMPATIBILITY_FLAGS.length || !sameSet(flags, COMPATIBILITY_FLAGS)) {
      failures.push(`compatibility: flags must be exactly ${COMPATIBILITY_FLAGS.join(', ')}`);
    }
  }
  if (closed(failures, 'workerSettings', state.workerSettings, ['observability', 'workersDev', 'previewUrls'])) {
    const settings = state.workerSettings;
    if (settings.observability !== true) failures.push('workerSettings: observability must be on');
    if (settings.workersDev !== false) failures.push('workerSettings: workers.dev must be off');
    if (settings.previewUrls !== false) failures.push('workerSettings: preview URLs must be off');
  }
  if (!Array.isArray(state.routes) || state.routes.length) failures.push('routes: zone routes are not allowed; every host is a custom domain');

  if (closed(failures, 'workers', state.workers, WORKERS)) {
    const hosts = new Map();
    const repositories = new Map();
    for (const name of WORKERS) if (Object.hasOwn(state.workers, name)) validateWorker(failures, name, state.workers[name], hosts, repositories);
  }

  if (exactlyOne(failures, 'd1', state.d1, 'D1 database') && state.d1[0] !== D1_DATABASE) {
    failures.push(`d1: the database must be named ${D1_DATABASE}`);
  }
  if (exactlyOne(failures, 'r2', state.r2, 'R2 bucket')) validateBucket(failures, state.r2[0]);
  if (!Array.isArray(state.kv) || state.kv.length) failures.push('kv: KV namespaces are not allowed');
  if (exactlyOne(failures, 'secretsStore', state.secretsStore, 'Secrets Store')) validateStore(failures, state.secretsStore[0]);
  return failures;
}

export function loadCloudflareDesiredState(root) {
  return JSON.parse(readFileSync(join(root, 'config/cloudflare.json'), 'utf8'));
}
