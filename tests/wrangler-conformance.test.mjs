import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DESIRED } from '../platform/conformance/desired.mjs';
import { parseJsonc } from '../platform/conformance/jsonc.mjs';
import { renderWranglerTemplate } from '../platform/conformance/template.mjs';
import { checkWranglerConfig, checkWranglerSource } from '../platform/conformance/wrangler.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const desired = JSON.parse(read('../config/cloudflare.json'));
const template = read('../platform/wrangler.template.jsonc');
const STORE_ID = '0123456789abcdef0123456789abcdef';
const render = (label) => renderWranglerTemplate(template, label, { secretsStoreId: STORE_ID });
const check = (label, config) => checkWranglerConfig(config, { label, worker: desired.workers[label] });

function failsWith(label, mutate, pattern) {
  const config = structuredClone(render(label));
  mutate(config);
  const failures = check(label, config);
  assert.ok(failures.some((failure) => pattern.test(failure)), `expected ${pattern} in ${JSON.stringify(failures)}`);
}

test('the vendored policy mirrors config/cloudflare.json', () => {
  const projected = {
    compatibility: desired.compatibility,
    workerSettings: desired.workerSettings,
    d1: { binding: 'WG_DB', name: desired.d1[0] },
    r2: { binding: 'WG_R2', name: desired.r2[0].name },
    secretsStoreSecrets: desired.secretsStore[0].secrets,
    workers: Object.fromEntries(Object.entries(desired.workers).map(([label, worker]) => [label, {
      host: worker.host, aliases: worker.aliases, durableObjects: worker.durableObjects, crons: worker.crons, secrets: worker.secrets,
    }])),
  };
  assert.deepEqual(JSON.parse(JSON.stringify(DESIRED)), projected);
  assert.equal(desired.d1.length, 1);
  assert.equal(desired.r2.length, 1);
  assert.ok(Object.isFrozen(DESIRED.workers.demo.durableObjects));
});

test('the template renders a conforming config for each of the four Workers', () => {
  assert.deepEqual(Object.keys(desired.workers).sort(), ['demo', 'hexframe', 'sharktank', 'wizardgang']);
  for (const label of Object.keys(desired.workers)) {
    assert.deepEqual(check(label, render(label)), [], label);
    const source = JSON.stringify(render(label));
    assert.deepEqual(checkWranglerSource(source, label), [], `${label} via the vendored policy`);
  }
  assert.deepEqual(render('demo').triggers, { crons: ['*/5 * * * *'] });
  assert.deepEqual(render('sharktank').durable_objects, { bindings: [{ name: 'Room', class_name: 'Room' }] });
  assert.throws(() => renderWranglerTemplate(template, 'portfolio', { secretsStoreId: STORE_ID }), /not a declared Worker/);
  assert.throws(() => renderWranglerTemplate(template, 'demo', { secretsStoreId: '__SECRETS_STORE_ID__' }), /Secrets Store ID/);
});

test('the unrendered template and Hexframe at f95b735 do not conform', () => {
  assert.ok(checkWranglerSource(template, 'hexframe').some((failure) => /name must equal/.test(failure)));
  const failures = checkWranglerSource(read('fixtures/wrangler-hexframe-f95b735.jsonc'), 'hexframe');
  for (const pattern of [/^env: environment blocks/, /^routes is required/, /^workers_dev is required/,
    /^compatibility_date must be 2026-08-31/, /^vars\.WG_APP must equal/]) {
    assert.ok(failures.some((failure) => pattern.test(failure)), `${pattern} in ${JSON.stringify(failures)}`);
  }
  assert.deepEqual(checkWranglerSource('{}', 'portfolio'), ['"portfolio" is not a declared Worker']);
  assert.match(checkWranglerSource('{ "name": ', 'hexframe')[0], /not valid JSONC/);
});

test('top-level shape: no env blocks, no account_id, no unknown keys', () => {
  failsWith('hexframe', (config) => { config.env = { production: {} }; }, /^env: environment blocks/);
  failsWith('hexframe', (config) => { config.account_id = 'from-config'; }, /^account_id: the account ID is never committed/);
  failsWith('hexframe', (config) => { config.route = 'hexframe.wizardgang.ai/*'; }, /^route: use routes/);
  failsWith('hexframe', (config) => { config.services = []; }, /^services is not an allowed top-level key/);
  failsWith('hexframe', (config) => { config.version_metadata = { binding: 'CF_VERSION' }; }, /^version_metadata is not an allowed/);
  failsWith('hexframe', (config) => { delete config.main; }, /^main is required/);
  assert.deepEqual(check('hexframe', []), ['the wrangler config must be a JSON object']);
});

test('identity: name is the Worker label and WG_APP is the name', () => {
  failsWith('hexframe', (config) => { config.name = 'hexframe-staging'; }, /^name must equal the Worker label "hexframe"/);
  failsWith('hexframe', (config) => { config.vars.WG_APP = 'demo'; }, /^vars\.WG_APP must equal the Worker name/);
  failsWith('hexframe', (config) => { delete config.vars.WG_APP; }, /^vars\.WG_APP must equal/);
  failsWith('hexframe', (config) => { config.vars.WG_OPS_TOKEN = 'plain'; }, /^vars\.WG_OPS_TOKEN is reserved/);
  failsWith('demo', (config) => { config.vars.GITHUB_OAUTH_CLIENT_SECRET = 'plain'; }, /^vars\.GITHUB_OAUTH_CLIENT_SECRET is a secret/);
  // A registry Worker secret is refused as a var on every Worker, not only on the Workers that consume it.
  failsWith('hexframe', (config) => { config.vars.GITHUB_APP_PRIVATE_KEY = 'plain'; }, /^vars\.GITHUB_APP_PRIVATE_KEY is a secret/);
  failsWith('wizardgang', (config) => { config.vars.CLOUDFLARE_BILLING_TOKEN = 'plain'; }, /^vars\.CLOUDFLARE_BILLING_TOKEN is a secret/);
  failsWith('demo', (config) => { config.vars.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef'; }, /^vars\.CLOUDFLARE_ACCOUNT_ID is never committed/);
  failsWith('demo', (config) => { config.secrets_store_secrets.push({ binding: 'GITHUB_APP_PRIVATE_KEY', store_id: STORE_ID, secret_name: 'GITHUB_APP_PRIVATE_KEY' }); }, /binds "GITHUB_APP_PRIVATE_KEY"; only WG_OPS_TOKEN and WG_SESSION_KEY/);
  failsWith('hexframe', (config) => { config.vars.ENVIRONMENT = 1; }, /^vars\.ENVIRONMENT must be a string/);
  assert.deepEqual(check('hexframe', { ...render('hexframe'), vars: { WG_APP: 'hexframe', ENVIRONMENT: 'production' } }), []);
});

test('routes: exactly one custom domain for the declared host; www only for wizardgang', () => {
  const www = { pattern: 'www.wizardgang.ai', custom_domain: true };
  assert.deepEqual(check('wizardgang', { ...render('wizardgang'), routes: [render('wizardgang').routes[0], www] }), []);
  failsWith('hexframe', (config) => { config.routes.push(www); }, /^routes\[1\] "www\.wizardgang\.ai" is not this Worker's declared host/);
  failsWith('hexframe', (config) => { config.routes = []; }, /^routes must contain the declared host hexframe\.wizardgang\.ai exactly once/);
  failsWith('hexframe', (config) => { config.routes.push({ ...config.routes[0] }); }, /exactly once/);
  failsWith('wizardgang', (config) => { config.routes.push(www, www); }, /^routes must not repeat a host/);
  failsWith('hexframe', (config) => { config.routes[0].custom_domain = false; }, /must be a custom domain, not a zone route/);
  failsWith('hexframe', (config) => { config.routes[0] = { pattern: 'hexframe.wizardgang.ai/*', zone_name: 'wizardgang.ai' }; }, /zone_name is not allowed/);
  failsWith('hexframe', (config) => { config.routes[0].pattern = 'demo.wizardgang.ai'; }, /not this Worker's declared host/);
  failsWith('hexframe', (config) => { config.routes = 'hexframe.wizardgang.ai'; }, /^routes must be an array/);
});

test('shared settings: workers.dev, preview URLs, observability and compatibility', () => {
  failsWith('hexframe', (config) => { config.workers_dev = true; }, /^workers_dev must be false/);
  failsWith('hexframe', (config) => { delete config.workers_dev; }, /^workers_dev is required/);
  failsWith('hexframe', (config) => { config.preview_urls = true; }, /^preview_urls must be false/);
  failsWith('hexframe', (config) => { config.observability = { enabled: false }; }, /^observability\.enabled must be true/);
  failsWith('hexframe', (config) => { delete config.observability; }, /^observability\.enabled must be true/);
  failsWith('hexframe', (config) => { config.compatibility_date = '2026-06-28'; }, /^compatibility_date must be 2026-08-31/);
  failsWith('hexframe', (config) => { config.compatibility_flags = []; }, /^compatibility_flags must be exactly/);
  failsWith('hexframe', (config) => { config.compatibility_flags.push('assets_navigation_has_no_effect'); }, /^compatibility_flags must be exactly/);
  failsWith('hexframe', (config) => { config.compatibility_flags.push('nodejs_compat'); }, /^compatibility_flags must be exactly/);
});

test('storage bindings: D1 wizardgang as WG_DB, R2 wizardgang as WG_R2, no KV', () => {
  failsWith('hexframe', (config) => { config.kv_namespaces = [{ binding: 'CACHE', id: 'x' }]; }, /^kv_namespaces: KV is not part of the platform/);
  failsWith('hexframe', (config) => { config.d1_databases[0].binding = 'DB'; }, /^d1_databases\[0\]\.binding must be WG_DB/);
  failsWith('hexframe', (config) => { config.d1_databases[0].database_name = 'demo-blob'; }, /^d1_databases\[0\]\.database_name must be wizardgang/);
  failsWith('hexframe', (config) => { config.d1_databases.push({ ...config.d1_databases[0] }); }, /^d1_databases must hold exactly one WG_DB binding/);
  failsWith('hexframe', (config) => { config.d1_databases[0].migrations_dir = 'migrations'; }, /migrations_dir is not allowed/);
  failsWith('hexframe', (config) => { config.d1_databases[0].database_id = 'not-a-uuid'; }, /database_id is malformed/);
  failsWith('hexframe', (config) => { config.r2_buckets[0].bucket_name = 'wizardgang-demo-r2'; }, /^r2_buckets\[0\]\.bucket_name must be wizardgang/);
  failsWith('hexframe', (config) => { config.r2_buckets[0].binding = 'ASSETS_BUCKET'; }, /^r2_buckets\[0\]\.binding must be WG_R2/);
  failsWith('hexframe', (config) => { config.r2_buckets[0].preview_bucket_name = 'x'; }, /preview_bucket_name is not allowed/);
  failsWith('hexframe', (config) => { config.assets = { directory: './dist', binding: 'STATIC' }; }, /^assets\.binding must be ASSETS/);
  const withId = render('hexframe');
  withId.d1_databases[0].database_id = '01234567-89ab-cdef-0123-456789abcdef';
  delete withId.r2_buckets;
  withId.assets = { directory: './dist', binding: 'ASSETS', run_worker_first: true };
  assert.deepEqual(check('hexframe', withId), []);
});

test('Durable Objects and crons are exactly the declared ones', () => {
  failsWith('hexframe', (config) => { config.durable_objects = { bindings: [{ name: 'ROOM', class_name: 'Room' }] }; }, /must be exactly the declared classes \[\]/);
  failsWith('sharktank', (config) => { config.durable_objects.bindings.push({ name: 'Lobby', class_name: 'Lobby' }); }, /Durable Object bindings/);
  failsWith('sharktank', (config) => { config.durable_objects.bindings[0].script_name = 'wizardgangprod'; }, /script_name is not allowed/);
  failsWith('sharktank', (config) => { delete config.migrations; }, /^migrations leave classes \[\]/);
  failsWith('sharktank', (config) => { config.migrations.push({ tag: 'v2', deleted_classes: ['Room'] }); }, /^migrations leave classes \[\]/);
  failsWith('sharktank', (config) => { config.migrations.push({ tag: 'v2', deleted_classes: ['Ghost'] }); }, /deletes "Ghost", which no earlier step created/);
  failsWith('sharktank', (config) => { config.migrations[0].new_sqlite_classes.push('Lobby'); }, /^migrations leave classes/);
  failsWith('demo', (config) => { delete config.triggers; }, /^triggers\.crons must be exactly \["\*\/5 \* \* \* \*"\]/);
  failsWith('demo', (config) => { config.triggers.crons.push('17 3 * * *'); }, /^triggers\.crons must be exactly/);
  failsWith('hexframe', (config) => { config.triggers = { crons: ['17 3 * * *'] }; }, /^triggers\.crons must be exactly \[\]/);
  // Real history replays to the declared set: SharkTank's Lobby deletion (ST-149) and a transfer from wizardgangprod.
  const history = render('sharktank');
  history.migrations = [
    { tag: 'v1', transferred_classes: [{ from: 'Room', from_script: 'wizardgangprod', to: 'Room' }] },
    { tag: 'v2', new_sqlite_classes: ['Lobby'] },
    { tag: 'v3', deleted_classes: ['Lobby'] },
  ];
  assert.deepEqual(check('sharktank', history), []);
  const hexframe = render('hexframe');
  hexframe.migrations = parseJsonc(read('fixtures/wrangler-hexframe-f95b735.jsonc')).migrations;
  assert.deepEqual(check('hexframe', hexframe), []);
});

test('Secrets Store bindings only for WG_OPS_TOKEN and WG_SESSION_KEY', () => {
  const bind = (name) => ({ binding: name, store_id: STORE_ID, secret_name: name });
  failsWith('demo', (config) => { config.secrets_store_secrets.push(bind('GITHUB_OAUTH_CLIENT_SECRET')); }, /binds "GITHUB_OAUTH_CLIENT_SECRET"; only WG_OPS_TOKEN and WG_SESSION_KEY/);
  failsWith('hexframe', (config) => { config.secrets_store_secrets.push(bind('WG_OPS_TOKEN')); }, /repeats WG_OPS_TOKEN/);
  failsWith('hexframe', (config) => { config.secrets_store_secrets[0].secret_name = 'OPS_TOKEN'; }, /secret_name must equal its binding/);
  failsWith('hexframe', (config) => { config.secrets_store_secrets[0].store_id = 'default_secrets_store'; }, /store_id is malformed/);
  const tokenOnly = render('hexframe');
  tokenOnly.secrets_store_secrets = [bind('WG_OPS_TOKEN')];
  assert.deepEqual(check('hexframe', tokenOnly), []);
});

test('JSONC: comments and trailing commas, never inside strings', () => {
  assert.deepEqual(parseJsonc('{\n // a\n "a": "x//y", /* b */ "b": [1, 2,], "c": "q\\"/*",\n}'), { a: 'x//y', b: [1, 2], c: 'q"/*' });
  assert.deepEqual(parseJsonc('{ "url": "https://example.test/*,]" }'), { url: 'https://example.test/*,]' });
  assert.throws(() => parseJsonc('{ /* open'), /unterminated block comment/);
  assert.throws(() => parseJsonc('{ "a": "open }'), /unterminated string/);
  assert.throws(() => parseJsonc('{ "a": 1 } trailing'), SyntaxError);
});
