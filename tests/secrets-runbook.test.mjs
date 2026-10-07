import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadCloudflareDesiredState } from '../scripts/cloudflare-desired-state.mjs';
import { configRepositories, registryTargets, rotatableCredentials } from '../scripts/cloudflare-token-targets.mjs';
import { validateRepositoryAt } from '../scripts/repository-contract.mjs';
import { canonicalName, loadSecretRegistry } from '../scripts/secret-registry.mjs';
import { DERIVED_KEYS } from '../platform/wg-edge/keys.mjs';
import { GITHUB_APP } from '../platform/wg-edge/github.mjs';
import { recordedResponses } from './fixtures/cloudflare-api.mjs';
import { WRANGLER, brokenLinks, commands, hasPartsInOrder, npmScripts, repositoryLoops, sections, sharedRunbookFailures } from './fixtures/runbook.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const RUNBOOK = 'docs/SECRETS-RUNBOOK.md';
const runbook = read(RUNBOOK);
const registry = loadSecretRegistry(root);
const desired = loadCloudflareDesiredState(root);
const scripts = JSON.parse(read('package.json')).scripts;
const steps = sections(runbook);
const recorded = recordedResponses('2026-10-03');
const DEMO = 'Wizard-Gang/wizardgang-architecture-demo';
const DEMO_WORKERS = ['wizardgang-architecture-demo', 'demo'];
// The demo Worker's secrets in the recorded 2026-10-03 inventory: the names the registry replaces.
const recordedDemo = recorded['/workers/scripts/wizardgang-architecture-demo/secrets'].body.result.map((secret) => secret.name);
const workerSecrets = registry.entries.filter((entry) => entry.home === 'worker' && entry.kind === 'secret').map((entry) => entry.name);
const replaced = recordedDemo.filter((name) => !workerSecrets.includes(name));
// GitHub-side names from the 2026-10-04 inventory in the plan, outside the registry and the Cloudflare fixture.
const INVENTORY_2026_10_04 = ['GIT_DEMO_PR_TOKEN', 'GITHUB_REPORTING_WRITE_TOKEN', 'CLOUDFLARE_DO_NAMESPACE', 'PRODUCTION_DEPLOY_ENABLED', 'PRODUCTION_HOST'];
const credentials = [...new Set([...registry.entries, ...registry.exceptions].map((entry) => entry.credential).filter(Boolean))];
const secretsWithoutConsole = registry.entries.filter((entry) => entry.kind === 'secret' && entry.credential === null).map((entry) => entry.name);
const CONSOLE_ONLY = ['wg-saml-idp']; // the SAML IdP application: public configuration, no secret
const RETIRED_CONSOLE = ['wg-cloudflare-demo']; // retired by X5
const CREDENTIAL_PARTS = ['Precondition', 'Mint and set', 'Read-back', 'Rotate', 'Revoke', 'Rollback'];
const STEP_PARTS = ['Precondition', 'Command', 'Read-back', 'Rollback'];

test('the README and the control map link the secrets runbook', () => {
  assert.match(read('README.md'), /\]\(docs\/SECRETS-RUNBOOK\.md\)/);
  assert.match(read('docs/CONTROL-MAP.md'), /\]\(SECRETS-RUNBOOK\.md\)/);
});

test('every relative link and heading anchor in the runbook resolves', () => {
  const { links, broken } = brokenLinks(runbook, root);
  assert.ok(links.length >= 8);
  assert.deepEqual(broken, []);
});

test('every credential has a section with its six parts, and every retirement its four', () => {
  const credentialSteps = steps.filter(({ part }) => !part.startsWith('Retire'));
  const titles = credentialSteps.map(({ title }) => title.split(' ')[0]);
  assert.deepEqual(titles.sort(), [...credentials, ...secretsWithoutConsole, ...CONSOLE_ONLY].sort());
  for (const { title, body } of credentialSteps) assert.ok(hasPartsInOrder(body, CREDENTIAL_PARTS), `${title} must list its six parts in order`);
  const retirements = steps.filter(({ part }) => part.startsWith('Retire'));
  assert.deepEqual(retirements.map(({ title }) => title.split(' ')[0]), ['X1', 'X2', 'X3', 'X4', 'X5']);
  for (const { title, body } of retirements) assert.ok(hasPartsInOrder(body, STEP_PARTS), `${title} must list its four parts in order`);
});

test('every registry name appears, and the derived keys follow keys.mjs', () => {
  for (const { name } of registry.entries) assert.match(runbook, new RegExp(`(?<![\\w-])${name}(?![\\w-])`), `the runbook must name ${name}`);
  const derived = registry.entries.filter((entry) => entry.kind === 'derived').map((entry) => entry.name);
  assert.deepEqual(Object.keys(DERIVED_KEYS).sort(), derived.sort());
  const section = steps.find(({ title }) => title.startsWith('WG_SESSION_KEY'));
  const intro = runbook.slice(runbook.indexOf('### WG_SESSION_KEY'), runbook.indexOf('- **Precondition:**', runbook.indexOf('### WG_SESSION_KEY')));
  for (const label of derived) assert.ok(intro.includes(`\`${label}\``), `the derived key ${label} belongs to WG_SESSION_KEY`);
  const keys = read('platform/wg-edge/keys.mjs');
  for (const [constant, phrase] of [[/'(wizardgang wg-edge derived key v1)'/, 'salt'], [/INFO_PREFIX = '([^']+)'/, 'info']]) {
    const value = constant.exec(keys)[1];
    assert.ok(intro.includes(`${phrase} \`${value}`), `the runbook states the HKDF ${phrase} ${value}`);
  }
  assert.match(section.body, /registry and `DERIVED_KEYS` together/);
});

test('every command writes a registry name to its registry home', () => {
  const targets = registryTargets(registry, configRepositories(desired));
  const workerWrites = [...runbook.matchAll(new RegExp(`${WRANGLER} secret put (\\S+) --name "\\$W"`, 'g'))].map((match) => match[1]);
  for (const name of workerWrites) assert.ok(workerSecrets.includes(name) || replaced.includes(name), `${name} is not a demo Worker secret`);
  for (const name of workerSecrets) assert.ok(workerWrites.includes(name), `the runbook must put ${name} on the demo Worker`);
  for (const [, worker] of runbook.matchAll(/\bW=([a-z0-9-]+)/g)) assert.ok(DEMO_WORKERS.includes(worker), `W=${worker} is not the demo Worker`);
  for (const [, kind, name, repository, environment] of runbook.matchAll(/gh (secret|variable) set ([A-Z_]+) --repo ([^\s`]+) --env ([a-z0-9-]+)/g)) {
    if (repository === '"$r"') continue;
    assert.ok(targets.some((target) => target.kind === kind && target.name === name && target.repository === repository && target.environment === environment),
      `${kind} ${name} in ${repository}:${environment} is not a registry target`);
  }
  for (const [, name] of runbook.matchAll(/secrets-store secret (?:create|update)[^\n]*?(WG_[A-Z_]+)/g)) assert.ok(secretsWithoutConsole.includes(name));
  for (const loop of repositoryLoops(runbook)) assert.deepEqual(loop, configRepositories(desired));
});

test('every npm script exists, and each GitHub-environment token rotates through the registry tool', () => {
  for (const name of npmScripts(runbook)) assert.ok(Object.hasOwn(scripts, name), `npm run ${name} is not a package script`);
  for (const credential of rotatableCredentials(registry)) {
    assert.ok(runbook.includes(`pbpaste | npm run rotate:cloudflare-token -- --credential ${credential} --apply`), `rotate ${credential}`);
  }
  for (const [, credential] of runbook.matchAll(/rotate:cloudflare-token -- --credential (\S+)/g)) {
    assert.ok(rotatableCredentials(registry).includes(credential), `${credential} is not rotatable`);
  }
});

test('the GitHub App key is converted, set from stdin, fingerprinted and removed', () => {
  const section = steps.find(({ title }) => title === GITHUB_APP.credential).body;
  const actions = registry.entries.filter((entry) => entry.home === 'github-environment' && entry.consumers.includes(`${DEMO}:git-demo`));
  const actionsName = (kind) => actions.find((entry) => entry.kind === kind).name;
  assert.deepEqual(actions.map(canonicalName).sort(), [GITHUB_APP.id, GITHUB_APP.privateKey]);
  const create = `gh api -X PUT repos/${DEMO}/environments/git-demo --silent && `;
  for (const phrase of ['openssl pkcs8 -topk8 -nocrypt', `secret put ${GITHUB_APP.privateKey} --name "$W" < `, create,
    `gh secret set ${actionsName('secret')} --repo ${DEMO} --env git-demo < `, `gh variable set ${actionsName('variable')} --repo ${DEMO} --env git-demo`,
    'openssl rsa -in "$TMPDIR/wg-github-app.pkcs8.pem" -pubout -outform DER 2>/dev/null | openssl sha256 -binary | openssl base64',
    'rm -f ~/Downloads/wg-github-app.*.private-key.pem "$TMPDIR/wg-github-app.pkcs8.pem"', 'Generate a second private key']) {
    assert.ok(section.includes(phrase), `the App section must include ${phrase}`);
  }
  for (const set of ['gh variable set', 'gh secret set']) {
    assert.ok(section.indexOf(create) < section.indexOf(set), `the App section creates git-demo before ${set}`);
  }
  assert.doesNotMatch(section, /--env git-demo[^\n]*GITHUB_|(?:secret|variable) (?:set|delete) GITHUB_[A-Z_]+ --repo/,
    'GitHub refuses GITHUB_ names in Actions');
  assert.match(steps.find(({ title }) => title === 'wg-microsoft-oauth').body, /expiry/);
});

test('the retirements cover every replaced name, and X2 leaves exactly the registry secrets', () => {
  const table = runbook.slice(runbook.indexOf('| Old name'), runbook.indexOf('### X1'));
  for (const name of [...replaced, 'GIT_DEMO_PR_TOKEN']) assert.ok(table.includes(`\`${name}\``), `the table must retire ${name}`);
  const x2 = steps.find(({ title }) => title.startsWith('X2')).body;
  const deleted = /for s in ([A-Z_ ]+); do/.exec(x2)[1].split(' ');
  const grepped = /grep -nwE "([A-Z_|]+)"/.exec(x2)[1].split('|');
  const later = ['MICROSOFT_TENANT_ID']; // deleted by X1, before the deploy that adds the variable
  assert.deepEqual(deleted.sort(), replaced.filter((name) => !later.includes(name)).sort());
  assert.deepEqual(grepped.sort(), deleted.sort());
  assert.match(steps.find(({ title }) => title.startsWith('X1')).body, /secret delete MICROSOFT_TENANT_ID --name "\$W"/);
  const kept = [...x2.slice(x2.indexOf('**Read-back:**')).matchAll(/`([A-Z_]+)`/g)].map((match) => match[1]);
  assert.deepEqual(kept.sort(), [...desired.workers.demo.secrets].sort());
});

test('the runbook names only registry, inventory and console names, with self-contained commands and no values', () => {
  assert.deepEqual(sharedRunbookFailures(runbook), []);
  assert.ok(commands(runbook).length > 60);
  const upper = new Set([...registry.entries.map((entry) => entry.name), ...recordedDemo, ...INVENTORY_2026_10_04, 'OPS_TOKEN', 'OPS_USERNAME',
    'DERIVED_KEYS', ...Object.values(desired.workers).flatMap((worker) => worker.secrets)]);
  const lower = new Set([...credentials, ...CONSOLE_ONLY, ...RETIRED_CONSOLE, ...registry.entries.filter((entry) => entry.kind === 'derived').map((entry) => entry.name),
    ...DEMO_WORKERS, ...desired.r2.map((bucket) => bucket.name), 'demo-blob', 'wizardgang-demo-assets', 'wizardgang-demo-r2', 'git-demo']);
  for (const [, span] of runbook.matchAll(/`([^`\s]+)`/g)) {
    if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(span)) assert.ok(upper.has(span), `\`${span}\` is outside the registry and inventory`);
    if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(span)) assert.ok(lower.has(span) || Object.hasOwn(scripts, span), `\`${span}\` is not a known name`);
  }
});

test('the repository contract requires the secrets runbook and its tests', () => {
  const copy = mkdtempSync(join(tmpdir(), 'baseline-secrets-runbook-'));
  try {
    cpSync(root, copy, { recursive: true, filter: (source) => !/^(?:\.git|node_modules|\.wrangler)(?:[\\/]|$)/.test(relative(root, source)) });
    assert.deepEqual(validateRepositoryAt(copy), []);
    for (const path of [RUNBOOK, 'tests/secrets-runbook.test.mjs']) {
      rmSync(join(copy, path));
      assert.ok(validateRepositoryAt(copy).includes(`missing or empty repository authority: ${path}`), `${path} must be required`);
      cpSync(join(root, path), join(copy, path));
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
