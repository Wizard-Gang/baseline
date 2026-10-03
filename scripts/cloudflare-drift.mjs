// Pure comparison between `config/cloudflare.json` and a normalized live Cloudflare read. Both sides are reduced to
// the same shape first, so every category compares by exact set equality and reports missing, unexpected and
// mismatched items. Live reads live in `cloudflare-live-state.mjs`; nothing here touches the network.

const DAY = 86400;

// Lifecycle transitions are compared one per canonical line, so grouping transitions into rules does not matter.
export function formatAge(seconds) {
  return Number.isInteger(seconds) && seconds > 0 && seconds % DAY === 0 ? `${seconds / DAY}d` : `${seconds}s`;
}

const scope = (prefix) => (prefix ? prefix : '(all objects)');
export const abortRule = (prefix, seconds) => `abort incomplete multipart uploads ${scope(prefix)} after ${formatAge(seconds)}`;
export const expiryRule = (prefix, seconds) => `expire ${scope(prefix)} after ${formatAge(seconds)}`;

export function expectedCloudflareState(desired) {
  const workers = Object.keys(desired.workers);
  const domains = {};
  const settings = {};
  for (const [name, worker] of Object.entries(desired.workers)) {
    for (const host of [worker.host, ...worker.aliases]) domains[host] = { worker: name, enabled: true };
    settings[name] = {
      compatibilityDate: desired.compatibility.date,
      compatibilityFlags: [...desired.compatibility.flags],
      observability: desired.workerSettings.observability,
      workersDev: desired.workerSettings.workersDev,
      previewUrls: desired.workerSettings.previewUrls,
    };
  }
  const entries = (key, format) => Object.entries(desired.workers).flatMap(([name, worker]) => worker[key].map((value) => format(name, value)));
  const lifecycle = {};
  for (const bucket of desired.r2) {
    lifecycle[bucket.name] = [
      abortRule('', bucket.abortIncompleteMultipartUploadDays * DAY),
      ...Object.values(bucket.prefixes).flatMap((entry) => entry.expiry.map((rule) => expiryRule(rule.prefix, rule.days * DAY))),
    ];
  }
  return {
    workers,
    domains,
    d1: [...desired.d1],
    r2: desired.r2.map((bucket) => bucket.name),
    kv: [...desired.kv],
    durableObjects: entries('durableObjects', (name, cls) => `${name}:${cls}`),
    crons: entries('crons', (name, cron) => `${name}: ${cron}`),
    secrets: entries('secrets', (name, secret) => `${name}:${secret}`),
    secretsStores: desired.secretsStore.map((store) => store.name),
    secretsStoreSecrets: desired.secretsStore.flatMap((store) => store.secrets.map((secret) => `${store.name}:${secret}`)),
    settings,
    lifecycle,
  };
}

const SET_CATEGORIES = [
  ['workers', 'Worker'],
  ['d1', 'D1 database'],
  ['r2', 'R2 bucket'],
  ['kv', 'KV namespace'],
  ['durableObjects', 'Durable Object'],
  ['crons', 'cron'],
  ['secrets', 'Worker secret'],
  ['secretsStores', 'Secrets Store'],
  ['secretsStoreSecrets', 'Secrets Store secret'],
];

const onOff = (value) => (value === true ? 'on' : value === false ? 'off' : 'unknown');
const flagList = (flags) => (flags.length ? [...flags].sort().join(', ') : '(none)');

function compareSet(drift, noun, expected, actual) {
  for (const entry of expected) if (!actual.includes(entry)) drift.missing.push(`${noun} ${entry}`);
  for (const entry of actual) if (!expected.includes(entry)) drift.unexpected.push(`${noun} ${entry}`);
}

function compareSettings(drift, name, expected, actual) {
  const label = `Worker ${name}`;
  if (actual.compatibilityDate !== expected.compatibilityDate) {
    drift.mismatched.push(`${label} compatibility date: expected ${expected.compatibilityDate}, got ${actual.compatibilityDate ?? '(none)'}`);
  }
  if (flagList(actual.compatibilityFlags) !== flagList(expected.compatibilityFlags)) {
    drift.mismatched.push(`${label} compatibility flags: expected ${flagList(expected.compatibilityFlags)}, got ${flagList(actual.compatibilityFlags)}`);
  }
  for (const [key, title] of [['observability', 'observability'], ['workersDev', 'workers.dev'], ['previewUrls', 'preview URLs']]) {
    if (actual[key] !== expected[key]) drift.mismatched.push(`${label} ${title}: expected ${onOff(expected[key])}, got ${onOff(actual[key])}`);
  }
}

export function compareCloudflareState(expected, actual) {
  const drift = { missing: [], unexpected: [], mismatched: [] };
  for (const [key, noun] of SET_CATEGORIES) compareSet(drift, noun, expected[key], actual[key]);

  for (const [host, want] of Object.entries(expected.domains)) {
    const got = actual.domains[host];
    if (!got) drift.missing.push(`custom domain ${host} → ${want.worker}`);
    else if (got.worker !== want.worker) drift.mismatched.push(`custom domain ${host}: expected Worker ${want.worker}, got ${got.worker}`);
    else if (got.enabled !== true) drift.mismatched.push(`custom domain ${host}: expected enabled, got disabled`);
  }
  for (const [host, got] of Object.entries(actual.domains)) {
    if (!Object.hasOwn(expected.domains, host)) drift.unexpected.push(`custom domain ${host} → ${got.worker}`);
  }

  // Settings and lifecycle rules belong to a declared resource; an absent resource is already reported as missing.
  for (const [name, want] of Object.entries(expected.settings)) {
    if (actual.settings[name]) compareSettings(drift, name, want, actual.settings[name]);
  }
  for (const [bucket, rules] of Object.entries(expected.lifecycle)) {
    if (actual.lifecycle[bucket]) compareSet(drift, `R2 lifecycle rule ${bucket}:`, rules, actual.lifecycle[bucket]);
  }
  return drift;
}

export const hasDrift = (drift) => drift.missing.length + drift.unexpected.length + drift.mismatched.length > 0;
