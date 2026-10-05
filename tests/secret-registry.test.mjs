import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadCloudflareDesiredState } from '../scripts/cloudflare-desired-state.mjs';
import { validateRepositoryAt } from '../scripts/repository-contract.mjs';
import {
  crossCheckSecretRegistry, loadSecretRegistry, validateSecretRegistry, validateSecretRegistryAt,
} from '../scripts/secret-registry.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const committed = loadSecretRegistry(root);
const cloudflare = loadCloudflareDesiredState(root);
const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
const DEMO = 'SouthernGentlemen/wizardgang-architecture-demo';
const find = (registry, name, home) => registry.entries.find((entry) => entry.name === name && entry.home === home);

function failuresFor(mutate) {
  const registry = structuredClone(committed);
  const config = structuredClone(cloudflare);
  mutate(registry, config);
  const failures = validateSecretRegistry(registry);
  return failures.length ? failures : crossCheckSecretRegistry(registry, config, scripts);
}

function rejects(mutate, expected) {
  const failures = failuresFor(mutate);
  assert.ok(failures.some((failure) => failure.includes(expected)),
    `expected a failure containing ${JSON.stringify(expected)}, got ${JSON.stringify(failures)}`);
}

test('the committed registry passes and agrees with config/cloudflare.json', () => {
  assert.deepEqual(validateSecretRegistry(committed), []);
  assert.deepEqual(validateSecretRegistryAt(root), []);
});

test('the committed registry records the 2026-10-04 target', () => {
  const names = (home, kind) => committed.entries.filter((entry) => entry.home === home && entry.kind === kind)
    .map((entry) => entry.name).sort();
  assert.deepEqual(names('github-environment', 'secret'), ['APP_PRIVATE_KEY', 'CLOUDFLARE_API_TOKEN']);
  assert.deepEqual(names('github-environment', 'variable'), ['APP_ID', 'CLOUDFLARE_ACCOUNT_ID']);
  assert.deepEqual(names('secrets-store', 'secret'), ['WG_OPS_TOKEN', 'WG_SESSION_KEY']);
  assert.deepEqual(names('secrets-store', 'derived'), ['demo-session', 'identity-audit', 'identity-session']);
  assert.deepEqual(names('worker', 'secret'), cloudflare.workers.demo.secrets);
  assert.deepEqual(names('worker', 'variable'), ['GITHUB_APP_ID', 'GITHUB_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_ID',
    'MICROSOFT_OAUTH_CLIENT_ID', 'MICROSOFT_TENANT_ID', 'SAML_IDP_CERT', 'SAML_IDP_ISSUER', 'SAML_SSO_URL']);
  assert.deepEqual(names('keychain', 'secret'), ['wg-cloudflare-audit']);
  const credentials = committed.entries.filter((entry) => entry.credential).map((entry) => `${entry.name}=${entry.credential}`);
  assert.deepEqual([...new Set(credentials)].sort(), ['APP_PRIVATE_KEY=wg-github-app', 'CLOUDFLARE_API_TOKEN=wg-cloudflare-deploy',
    'CLOUDFLARE_BILLING_TOKEN=wg-cloudflare-billing', 'GITHUB_APP_PRIVATE_KEY=wg-github-app',
    'GITHUB_OAUTH_CLIENT_SECRET=wg-github-oauth', 'GOOGLE_OAUTH_CLIENT_SECRET=wg-google-oauth',
    'MICROSOFT_OAUTH_CLIENT_SECRET=wg-microsoft-oauth', 'wg-cloudflare-audit=wg-cloudflare-audit']);
  assert.deepEqual(find(committed, 'APP_PRIVATE_KEY', 'github-environment').consumers, [`${DEMO}:git-demo`]);
  assert.deepEqual(find(committed, 'APP_ID', 'github-environment').consumers, [`${DEMO}:git-demo`]);
  // The demo's own deploy token is the one exception, and it ends with the demo's Phase 4 D1 move.
  assert.equal(committed.exceptions.length, 1);
  const [exception] = committed.exceptions;
  assert.deepEqual([exception.name, exception.home, exception.consumer, exception.credential],
    ['CLOUDFLARE_API_TOKEN', 'github-environment', `${DEMO}:production`, 'wg-cloudflare-demo']);
  assert.match(exception.until, /Phase 4/);
  assert.match(exception.until, /wg-cloudflare-demo is revoked/);
});

test('unknown keys are rejected at every level', () => {
  rejects((registry) => { registry.owner = 'jacob'; }, 'secrets: unknown key owner');
  rejects((registry) => { registry.entries[0].value = 'redacted'; }, 'entries[0]: unknown key value');
  rejects((registry) => { find(registry, 'WG_OPS_TOKEN', 'secrets-store').source = 'WG_SESSION_KEY'; }, 'unknown key source');
  rejects((registry) => { registry.exceptions[0].expires = '2027-01-01'; }, 'exceptions[0]: unknown key expires');
  rejects((registry) => { delete registry.entries[1].purpose; }, 'entries[1]: missing key purpose');
  rejects((registry) => { registry.entries[0].kind = 'password'; }, 'kind must be one of secret, variable, derived');
});

test('a misnamed secret is rejected', () => {
  const rename = (from, to) => (registry, config) => {
    find(registry, from, 'worker').name = to;
    config.workers.demo.secrets = config.workers.demo.secrets.map((name) => (name === from ? to : name)).sort();
  };
  rejects(rename('GITHUB_OAUTH_CLIENT_SECRET', 'GITHUB_CLIENT_SECRET'), 'GITHUB_CLIENT_SECRET must be named GITHUB_<PURPOSE>_<KIND>');
  rejects(rename('DEMO_WEBHOOK_SECRET', 'WEBHOOK_DEMO_SECRET'), 'WEBHOOK_DEMO_SECRET must start with DEMO_');
  rejects(rename('DEMO_WEBHOOK_SECRET', 'DEMO_SESSION_SECRET'), 'DEMO_SESSION_SECRET must be named DEMO_<PURPOSE>_<KIND>');
  rejects(rename('CLOUDFLARE_BILLING_TOKEN', 'CLOUDFLARE_API_TOKEN'), "CLOUDFLARE_API_TOKEN is wrangler's GitHub name");
  rejects(rename('GOOGLE_OAUTH_CLIENT_SECRET', 'google_oauth_client_secret'), 'must be an upper-case name');
  rejects((registry) => { find(registry, 'WG_OPS_TOKEN', 'secrets-store').provider = 'cloudflare'; },
    'WG_OPS_TOKEN must start with CLOUDFLARE_');
  rejects((registry) => { find(registry, 'GITHUB_WEBHOOK_SECRET', 'worker').home = 'secrets-store'; },
    'the Secrets Store holds only shared WG_ platform secrets');
  rejects((registry) => { find(registry, 'wg-cloudflare-audit', 'keychain').name = 'CLOUDFLARE_AUDIT_TOKEN'; },
    'a keychain item is named after its console credential');
});

test('a public value stored as a secret is rejected', () => {
  for (const name of ['MICROSOFT_TENANT_ID', 'GITHUB_OAUTH_CLIENT_ID', 'SAML_IDP_CERT', 'SAML_IDP_ISSUER', 'SAML_SSO_URL']) {
    rejects((registry) => { find(registry, name, 'worker').kind = 'secret'; }, `${name} is public configuration`);
  }
  rejects((registry) => { find(registry, 'CLOUDFLARE_ACCOUNT_ID', 'github-environment').kind = 'secret'; },
    'CLOUDFLARE_ACCOUNT_ID is public configuration');
  rejects((registry) => { find(registry, 'GITHUB_WEBHOOK_SECRET', 'worker').kind = 'variable'; },
    'GITHUB_WEBHOOK_SECRET names secret material and must be a secret');
});

test('a repository-level GitHub secret is rejected', () => {
  rejects((registry) => { find(registry, 'CLOUDFLARE_API_TOKEN', 'github-environment').consumers.push(DEMO); },
    `${DEMO} is a repository-level GitHub secret`);
  rejects((registry) => { find(registry, 'APP_PRIVATE_KEY', 'github-environment').home = 'github-repository'; },
    'repository-level GitHub secrets are not allowed');
  rejects((registry) => { find(registry, 'APP_ID', 'github-environment').consumers = ['Wizard-Gang/baseline:production']; },
    'Wizard-Gang/baseline is not a config/cloudflare.json repository');
});

test('a GitHub environment name never starts with GITHUB_, and a github name there drops the prefix', () => {
  for (const [name, kind] of [['APP_PRIVATE_KEY', 'secret'], ['APP_ID', 'variable']]) {
    rejects((registry) => { find(registry, name, 'github-environment').name = `GITHUB_${name}`; },
      `GITHUB_${name} starts with GITHUB_, which GitHub reserves for Actions secrets and variables`);
    assert.equal(find(committed, name, 'github-environment').kind, kind);
  }
  rejects((registry) => { find(registry, 'APP_PRIVATE_KEY', 'github-environment').name = 'APP_PRIVATE'; },
    'APP_PRIVATE must be named <PURPOSE>_<KIND>');
  rejects((registry) => { find(registry, 'CLOUDFLARE_API_TOKEN', 'github-environment').name = 'API_TOKEN'; },
    'API_TOKEN must start with CLOUDFLARE_ for provider cloudflare');
});

test('a duplicate name in one home and a shared console credential are rejected', () => {
  rejects((registry) => { registry.entries.push(structuredClone(find(registry, 'GITHUB_WEBHOOK_SECRET', 'worker'))); },
    'duplicate name GITHUB_WEBHOOK_SECRET in home worker');
  rejects((registry) => { find(registry, 'GITHUB_WEBHOOK_SECRET', 'worker').credential = 'wg-github-oauth'; },
    'console credential wg-github-oauth maps to both GITHUB_OAUTH_CLIENT_SECRET and GITHUB_WEBHOOK_SECRET');
  rejects((registry) => { find(registry, 'APP_PRIVATE_KEY', 'github-environment').credential = 'wg-github-actions'; },
    'GITHUB_APP_PRIVATE_KEY maps to more than one console credential');
  rejects((registry) => { find(registry, 'APP_PRIVATE_KEY', 'github-environment').name = 'APP_SIGNING_KEY'; },
    'console credential wg-github-app maps to both GITHUB_APP_SIGNING_KEY and GITHUB_APP_PRIVATE_KEY');
  rejects((registry) => { find(registry, 'CLOUDFLARE_BILLING_TOKEN', 'worker').credential = 'cloudflare-billing'; },
    'console credential must be named wg-cloudflare-<purpose>');
  rejects((registry) => { find(registry, 'GITHUB_APP_ID', 'worker').credential = 'wg-github-app'; }, 'only a secret has a console credential');
  rejects((registry) => { registry.exceptions[0].credential = 'wg-cloudflare-billing'; },
    'console credential wg-cloudflare-billing is already registered');
});

test('a derived key must name WG_SESSION_KEY as its source', () => {
  rejects((registry) => { find(registry, 'demo-session', 'secrets-store').source = 'WG_OPS_TOKEN'; },
    'derived key demo-session must name WG_SESSION_KEY as its source');
  rejects((registry) => { delete find(registry, 'identity-audit', 'secrets-store').source; }, 'missing key source');
  rejects((registry) => { find(registry, 'identity-session', 'secrets-store').home = 'worker'; },
    'derived key identity-session is a wizardgang secrets-store key');
});

test('the demo deploy-token exception stays bounded', () => {
  rejects((registry) => { registry.exceptions[0].consumer = 'Wizard-Gang/baseline:production'; }, 'does not use CLOUDFLARE_API_TOKEN');
  rejects((registry) => { registry.exceptions[0].until = ''; }, 'until must state the end condition');
  rejects((registry) => { registry.exceptions[0].name = 'CLOUDFLARE_ACCOUNT_ID'; }, 'must name a registered secret with a console credential');
});

test('any mismatch with config/cloudflare.json is rejected', () => {
  rejects((registry, config) => { config.workers.demo.secrets.push('GITHUB_READ_TOKEN'); },
    'workers.demo.secrets: GITHUB_READ_TOKEN is not in the registry');
  rejects((registry, config) => { config.workers.demo.secrets.shift(); },
    'workers.demo.secrets: registry secret CLOUDFLARE_BILLING_TOKEN is missing');
  rejects((registry) => { find(registry, 'GITHUB_WEBHOOK_SECRET', 'worker').consumers.push('hexframe'); },
    'workers.hexframe.secrets: registry secret GITHUB_WEBHOOK_SECRET is missing');
  rejects((registry, config) => { config.secretsStore[0].secrets.pop(); }, 'secretsStore: registry secret WG_SESSION_KEY is missing');
  rejects((registry) => { find(registry, 'CLOUDFLARE_ACCOUNT_ID', 'github-environment').consumers.pop(); },
    'CLOUDFLARE_ACCOUNT_ID: consumers must be exactly the deploying environments');
  rejects((registry) => { find(registry, 'wg-cloudflare-audit', 'keychain').consumers = ['verify:cloudflare-live']; },
    'verify:cloudflare-live is not a package script');
});

test('a committed value or a non-object registry fails closed', () => {
  rejects((registry) => { registry.entries[0].purpose = 'account 0123456789abcdef0123456789abcdef'; }, 'looks like a committed account or resource ID');
  assert.deepEqual(validateSecretRegistry(null), ['secrets must be an object']);
});

test('the repository contract requires the registry and fails a copy that drifts from it', (t) => {
  const copy = mkdtempSync(join(tmpdir(), 'baseline-secrets-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(root, copy, { recursive: true, filter: (source) => !/^(?:\.git|\.wrangler|node_modules)(?:[\\/]|$)/.test(relative(root, source)) });
  const path = join(copy, 'config/cloudflare.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.workers.demo.secrets.push('GITHUB_READ_TOKEN');
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  assert.ok(validateRepositoryAt(copy).some((failure) => failure.includes('config/secrets.json: config/cloudflare.json workers.demo.secrets')));
  for (const file of ['config/secrets.json', 'scripts/secret-registry.mjs', 'tests/secret-registry.test.mjs']) {
    const kept = readFileSync(join(copy, file), 'utf8');
    rmSync(join(copy, file));
    assert.ok(validateRepositoryAt(copy).includes(`missing or empty repository authority: ${file}`), `${file} must be required`);
    writeFileSync(join(copy, file), kept);
  }
});
