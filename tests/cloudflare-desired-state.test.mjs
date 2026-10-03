import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COMPATIBILITY_FLAGS, MINIMUM_COMPATIBILITY_DATE, SECRETS_STORE_SECRETS, WORKERS,
  loadCloudflareDesiredState, validateCloudflareDesiredState,
} from '../scripts/cloudflare-desired-state.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const committed = loadCloudflareDesiredState(root);
const specimen = () => structuredClone(committed);

function rejects(mutate, expected) {
  const state = specimen();
  mutate(state);
  const failures = validateCloudflareDesiredState(state);
  assert.ok(failures.some((failure) => failure.includes(expected)),
    `expected a failure containing ${JSON.stringify(expected)}, got ${JSON.stringify(failures)}`);
}

test('the committed desired state passes', () => {
  assert.deepEqual(validateCloudflareDesiredState(committed), []);
});

test('the committed desired state declares the consolidation target', () => {
  assert.deepEqual(Object.keys(committed.workers), WORKERS);
  assert.deepEqual(Object.values(committed.workers).map((worker) => worker.host),
    ['wizardgang.ai', 'demo.wizardgang.ai', 'sharktank.wizardgang.ai', 'hexframe.wizardgang.ai']);
  assert.deepEqual(committed.workers.wizardgang.aliases, ['www.wizardgang.ai']);
  assert.ok(Object.values(committed.workers).every((worker) => worker.environment === 'production'));
  assert.ok(committed.compatibility.date >= MINIMUM_COMPATIBILITY_DATE);
  assert.deepEqual(committed.compatibility.flags, COMPATIBILITY_FLAGS);
  assert.deepEqual(committed.d1, ['wizardgang']);
  assert.deepEqual(committed.r2.map((bucket) => bucket.name), ['wizardgang']);
  assert.deepEqual(committed.r2[0].prefixes.demo.expiry, [{ prefix: 'demo/uploads/', days: 1 }]);
  assert.deepEqual(committed.kv, []);
  assert.deepEqual(committed.secretsStore[0].secrets, SECRETS_STORE_SECRETS);
  for (const name of ['wizardgang', 'sharktank', 'hexframe']) assert.deepEqual(committed.workers[name].secrets, []);
  assert.ok(!committed.workers.demo.secrets.some((secret) => secret.startsWith('DEMO_ADMIN_')));
});

test('unknown keys are rejected at every level', () => {
  rejects((state) => { state.staging = true; }, 'cloudflare: unknown key staging');
  rejects((state) => { state.workers.hexframe.logpush = true; }, 'workers.hexframe: unknown key logpush');
  rejects((state) => { state.r2[0].prefixes.demo.public = true; }, 'r2[0].prefixes.demo: unknown key public');
  rejects((state) => { state.workers['wizardgang-portfolio-staging'] = structuredClone(state.workers.hexframe); },
    'workers: unknown key wizardgang-portfolio-staging');
  rejects((state) => { delete state.workers.demo.crons; }, 'workers.demo: missing key crons');
});

test('hosts are unique, derived from the Worker label and served only as custom domains', () => {
  rejects((state) => { state.workers.hexframe.aliases = ['demo.wizardgang.ai']; }, 'duplicate host demo.wizardgang.ai');
  rejects((state) => { state.workers.sharktank.host = 'tank.wizardgang.ai'; }, 'host must be sharktank.wizardgang.ai');
  rejects((state) => { state.workers.demo.aliases = ['www.wizardgang.ai']; }, 'workers.demo: aliases must be empty');
  rejects((state) => { state.workers.wizardgang.aliases = []; }, 'aliases must be www.wizardgang.ai');
  rejects((state) => { state.routes = [{ pattern: 'wizardgang.ai/*' }]; }, 'zone routes are not allowed');
});

test('each Worker deploys from its own repository production environment', () => {
  rejects((state) => { state.workers.hexframe.environment = 'staging'; }, 'environment must be production');
  rejects((state) => { state.workers.hexframe.repository = state.workers.sharktank.repository; },
    'repository Wizard-Gang/SharkTank already owns Worker sharktank');
  rejects((state) => { state.workers.hexframe.repository = 'Hexframe'; }, 'owner/name GitHub repository');
});

test('a second D1 database, R2 bucket or Secrets Store is rejected', () => {
  rejects((state) => { state.d1.push('demo-blob'); }, 'd1: exactly one D1 database is allowed, found 2');
  rejects((state) => { state.d1 = ['demo-blob']; }, 'd1: the database must be named wizardgang');
  rejects((state) => { state.r2.push({ ...structuredClone(state.r2[0]), name: 'wizardgang-demo-r2' }); },
    'r2: exactly one R2 bucket is allowed, found 2');
  rejects((state) => { state.secretsStore.push({ name: 'second_store', secrets: [] }); },
    'secretsStore: exactly one Secrets Store is allowed, found 2');
  rejects((state) => { state.secretsStore[0].secrets.push('OPS_TOKEN'); }, 'secretsStore[0]: undeclared secret OPS_TOKEN');
});

test('any KV namespace is rejected', () => {
  rejects((state) => { state.kv = ['wg-gateway-status-prod']; }, 'kv: KV namespaces are not allowed');
});

test('an undeclared Durable Object class or cron is rejected', () => {
  rejects((state) => { state.workers.sharktank.durableObjects.push('Lobby'); }, 'undeclared Durable Object class sharktank:Lobby');
  rejects((state) => { state.workers.hexframe.durableObjects = ['Room']; }, 'undeclared Durable Object class hexframe:Room');
  rejects((state) => { state.workers.demo.durableObjects = []; }, 'missing Durable Object class demo:DemoCoordinator');
  rejects((state) => { state.workers.sharktank.crons = ['17 3 * * *']; }, 'workers.sharktank: undeclared cron 17 3 * * *');
  rejects((state) => { state.workers.demo.crons = []; }, 'workers.demo: missing cron */5 * * * *');
});

test('a committed account ID or binding ID is rejected', () => {
  const id = '0123456789abcdef0123456789abcdef';
  rejects((state) => { state.accountId = id; }, 'cloudflare.accountId: a committed account ID is not allowed');
  rejects((state) => { state.r2[0].account_id = 'redacted'; }, 'a committed account ID is not allowed');
  rejects((state) => { state.secretsStore[0].store_id = 'redacted'; }, 'a committed resource or binding ID is not allowed');
  rejects((state) => { state.zone = id; }, 'cloudflare.zone: looks like a committed account or resource ID');
});

test('a secret value field is rejected', () => {
  rejects((state) => { state.workers.demo.secrets[0] = { name: 'CLOUDFLARE_API_TOKEN', value: 'redacted' }; },
    'a secret value field is not allowed');
  rejects((state) => { state.workers.demo.secrets[0] = { name: 'CLOUDFLARE_API_TOKEN' }; },
    'entries are secret names only; secret values are never committed');
  rejects((state) => { state.secretsStore[0].secrets = [{ WG_OPS_TOKEN: 'redacted' }, 'WG_SESSION_KEY']; },
    'entries are secret names only');
  rejects((state) => { state.workers.hexframe.password = 'redacted'; }, 'a secret value field is not allowed');
});

test('Worker secrets stay names, never shadow the Secrets Store and never carry admin auth', () => {
  rejects((state) => { state.workers.demo.secrets.push('DEMO_ADMIN_USER'); }, 'DEMO_ADMIN_USER is an admin credential');
  rejects((state) => { state.workers.hexframe.secrets = ['ADMIN_PASSWORD']; }, 'ADMIN_PASSWORD is an admin credential');
  rejects((state) => { state.workers.sharktank.secrets = ['OPS_TOKEN']; }, 'OPS_TOKEN is an admin credential');
  rejects((state) => { state.workers.sharktank.secrets = ['WG_OPS_TOKEN']; }, 'WG_OPS_TOKEN is reserved for the Secrets Store');
  rejects((state) => { state.workers.demo.secrets.reverse(); }, 'workers.demo.secrets must be sorted');
  rejects((state) => { state.workers.demo.secrets.push('lower_case'); }, 'invalid entry "lower_case"');
});

test('shared settings and compatibility are enforced', () => {
  rejects((state) => { state.compatibility.date = '2026-06-28'; }, `date must be ${MINIMUM_COMPATIBILITY_DATE} or later`);
  rejects((state) => { state.compatibility.date = '2026-02-30'; }, 'YYYY-MM-DD calendar date');
  rejects((state) => { state.compatibility.flags = ['nodejs_compat', 'assets_navigation_has_no_effect']; }, 'flags must be exactly nodejs_compat');
  rejects((state) => { state.workerSettings.observability = false; }, 'observability must be on');
  rejects((state) => { state.workerSettings.workersDev = true; }, 'workers.dev must be off');
  rejects((state) => { state.workerSettings.previewUrls = true; }, 'preview URLs must be off');
});

test('R2 prefixes and lifecycle rules stay inside each app', () => {
  rejects((state) => { state.r2[0].prefixes.demo.prefix = 'uploads/'; }, 'prefix must be demo/');
  rejects((state) => { state.r2[0].prefixes.demo.expiry.push({ prefix: 'sharktank/backups/', days: 30 }); },
    'prefix must be a folder under demo/');
  rejects((state) => { state.r2[0].prefixes.demo.expiry.push({ prefix: 'demo/uploads/', days: 2 }); }, 'duplicate expiry prefix');
  rejects((state) => { state.r2[0].prefixes.demo.expiry[0].days = 0; }, 'days must be a whole number');
  rejects((state) => { delete state.r2[0].abortIncompleteMultipartUploadDays; }, 'missing key abortIncompleteMultipartUploadDays');
  rejects((state) => { delete state.r2[0].prefixes.hexframe; }, 'r2[0].prefixes: missing key hexframe');
});

test('a non-object desired state fails closed', () => {
  assert.deepEqual(validateCloudflareDesiredState(null), ['cloudflare must be an object']);
  assert.deepEqual(validateCloudflareDesiredState([]), ['cloudflare must be an object']);
});
