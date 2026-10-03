import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadCloudflareDesiredState } from '../scripts/cloudflare-desired-state.mjs';
import { expectedCloudflareState } from '../scripts/cloudflare-drift.mjs';
import { normalizeLifecycle } from '../scripts/cloudflare-live-state.mjs';
import { validateRepositoryAt } from '../scripts/repository-contract.mjs';
import { runVerifyCloudflare } from '../scripts/verify-cloudflare.mjs';
import { ENV, fakeFetch, recordedResponses } from './fixtures/cloudflare-api.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const RUNBOOK = 'docs/CLOUDFLARE-RUNBOOK.md';
const runbook = read(RUNBOOK);
const desired = loadCloudflareDesiredState(root);
const scripts = JSON.parse(read('package.json')).scripts;
const recorded = recordedResponses('2026-10-03');
const result = (path) => recorded[path].body.result;

// Every name the runbook may use: config/cloudflare.json plus the recorded 2026-10-03 inventory.
const workers = Object.entries(desired.workers);
const inventory = {
  workers: new Set([...workers.map(([name]) => name), ...result('/workers/scripts').map((script) => script.id)]),
  hosts: new Set([...workers.flatMap(([, w]) => [w.host, ...w.aliases]), ...result('/workers/domains').map((d) => d.hostname)]),
  d1: new Set([...desired.d1, ...result('/d1/database').map((db) => db.name)]),
  r2: new Set([...desired.r2.map((bucket) => bucket.name), ...result('/r2/buckets').buckets.map((bucket) => bucket.name)]),
  kv: new Set([...desired.kv, ...result('/storage/kv/namespaces').map((ns) => ns.title)]),
  stores: new Set([...desired.secretsStore.map((s) => s.name), ...result('/secrets_store/stores').map((s) => s.name)]),
  secrets: new Set([
    ...workers.flatMap(([, w]) => w.secrets), ...desired.secretsStore.flatMap((s) => s.secrets),
    ...Object.entries(recorded).filter(([path]) => path.endsWith('/secrets')).flatMap(([, r]) => r.body.result.map((s) => s.name)),
  ]),
  repositories: new Set(workers.map(([, w]) => w.repository)),
};
// Names the runbook introduces that are not Cloudflare resources: the keychain item, the shell's binding names and
// response header, the session variable for the Secrets Store ID and the GitHub secrets deploy-worker.yml reads.
const VOCABULARY = new Set(['wg-cloudflare-audit', 'content-security-policy', 'WG_DB', 'WG_R2', 'WG_APP', 'STORE_ID',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);
const known = (name) => VOCABULARY.has(name) || Object.values(inventory).some((names) => names.has(name));
const placeholder = (arg) => /^(?:<|"\$|\$)/.test(arg);

function sections() {
  const found = [];
  let part = null;
  for (const line of runbook.split('\n')) {
    if (line.startsWith('## ')) part = line.slice(3);
    else if (line.startsWith('### ')) found.push({ part, title: line.slice(4), body: '' });
    else if (found.length && found.at(-1).part === part) found.at(-1).body += `${line}\n`;
  }
  return found;
}

test('the README and the control map link the runbook', () => {
  assert.match(read('README.md'), /\]\(docs\/CLOUDFLARE-RUNBOOK\.md\)/);
  assert.match(read('docs/CONTROL-MAP.md'), /\]\(CLOUDFLARE-RUNBOOK\.md\)/);
});

test('every relative link in the runbook resolves', () => {
  const links = [...runbook.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]).filter((link) => !/^[a-z]+:/.test(link));
  assert.ok(links.length >= 5);
  for (const link of links) {
    assert.ok(existsSync(resolve(root, 'docs', link.split('#')[0])), `broken link ${link}`);
  }
});

test('every npm script the runbook runs exists, including the owner-run Cloudflare commands', () => {
  const used = new Set([...runbook.matchAll(/npm run (?:--silent )?([a-z][a-z0-9:-]*)/g)].map((match) => match[1]));
  for (const name of used) assert.ok(Object.hasOwn(scripts, name), `npm run ${name} is not a package script`);
  for (const name of ['check', 'verify:cloudflare', 'discover:cloudflare-token-targets', 'rotate:cloudflare-token']) {
    assert.ok(used.has(name), `the runbook must use npm run ${name}`);
  }
  assert.ok(runbook.includes('pbpaste | npm run rotate:cloudflare-token -- --apply'));
});

test('every step has a precondition, a command, a read-back and a rollback', () => {
  const steps = [...sections(), ...runbook.split('\n## ').filter((part) => part.startsWith('Deploy rollback'))
    .map((body) => ({ part: 'Deploy rollback', title: 'Deploy rollback', body }))];
  const count = (part) => steps.filter((step) => step.part.startsWith(part)).length;
  assert.deepEqual([count('Phase 1'), count('Phase 3'), count('Deploy rollback'), count('Later retirements')], [5, 6, 1, 6]);
  for (const { title, body } of steps) {
    const at = ['**Precondition:**', '**Command:**', '**Read-back:**', '**Rollback:**'].map((label) => body.indexOf(`- ${label}`));
    assert.ok(at.every((index, i) => index >= 0 && (i === 0 || index > at[i - 1])), `${title} must list its four parts in order`);
  }
});

test('the runbook names only resources from config/cloudflare.json and the 2026-10-03 inventory', () => {
  const uses = [];
  const add = (kind, pattern) => { for (const match of runbook.matchAll(pattern)) uses.push([kind, match[1]]); };
  add('workers', /wr delete ([^\s`]+)/g);
  add('workers', /wr (?:secret \w+ \S+|deployments list) --name (\S+?)[`;\s]/g);
  add('d1', /wr d1 (?:create|delete|info|execute|export|time-travel (?:info|restore)) ([^\s`]+)/g);
  add('r2', /wr r2 bucket (?:create|delete|info|lifecycle (?:set|list|add|remove)) ([^\s`]+)/g);
  add('kv', /wr kv namespace (?:create|delete) ([^\s`]+)/g);
  add('secrets', /--name ([A-Z][A-Z0-9_]+)/g);
  add('secrets', /gh secret (?:set|delete) ([^\s`]+)/g);
  add('repositories', /--repo ([^\s`]+)/g);
  add('hosts', /https:\/\/((?:[a-z0-9-]+\.)*wizardgang\.ai)/g);
  add('d1', /D1 database `?([a-z0-9-]+)/g);
  add('r2', /R2 bucket `?([a-z0-9-]+)/g);
  add('kv', /KV namespace `?([a-z0-9-]+)/g);
  add('workers', /(?:Worker secret|Durable Object) ([a-z0-9-]+):/g);
  add('stores', /Secrets Store secret ([a-z0-9_]+):/g);
  add('workers', /custom domain \S+ → ([a-z0-9-]+)/g);
  for (const match of [...runbook.matchAll(/git -C \.\.\/([^\s`]+)/g)].filter((m) => !placeholder(m[1]))) {
    assert.ok([...inventory.repositories].some((repository) => repository.endsWith(`/${match[1]}`)), `unknown checkout ${match[1]}`);
  }
  assert.ok(uses.length > 40);
  for (const [kind, name] of uses.filter(([, name]) => !placeholder(name))) {
    assert.ok(inventory[kind].has(name) || (kind === 'secrets' && VOCABULARY.has(name)), `${kind} ${name} is outside the authority`);
  }
  // Single-name code spans: lowercase hyphenated names and upper-case secret names.
  for (const [, span] of runbook.matchAll(/`([^`\s]+)`/g)) {
    if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(span) || /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(span)) {
      assert.ok(known(span) || Object.hasOwn(scripts, span), `\`${span}\` is not in config/cloudflare.json or the 2026-10-03 inventory`);
    }
  }
});

test('the runbook covers every Phase 1 delete, Phase 3 resource and later retirement', () => {
  const orphans = [['workers', 'wizardgang-portfolio-staging'], ['d1', 'wizardgang-demo-data'], ['r2', 'wizardgang-demo-r2-preview'],
    ['kv', 'wg-gateway-status-dev'], ['kv', 'wg-gateway-status-prod']];
  for (const [kind, name] of orphans) assert.ok(inventory[kind].has(name) && runbook.includes(`delete ${name}`), `Phase 1 must delete ${name}`);
  assert.match(runbook, /for s in ADMIN_PASSWORD ADMIN_SESSION_SECRET ADMIN_USERNAME; do wr secret delete "\$s" --name hexframe; done/);
  for (const name of desired.d1) assert.ok(runbook.includes(`wr d1 create ${name}`) && runbook.includes(`--json | jq -r .uuid`));
  for (const file of Object.keys(JSON.parse(read('platform/migrations/pins.json')))) {
    assert.ok(runbook.includes(`--remote --file platform/migrations/${file}`), `Phase 3 must apply ${file}`);
  }
  for (const { name } of desired.r2) assert.ok(runbook.includes(`wr r2 bucket create ${name}`) && runbook.includes(`lifecycle set ${name}`));
  for (const { secrets: names } of desired.secretsStore) {
    for (const name of names) assert.match(runbook, new RegExp(`secrets-store secret create "\\$STORE_ID" --name ${name} --scopes workers --remote`));
  }
  // Every live Worker that is neither declared nor a Phase 1 orphan retires after its rename.
  const old = [...inventory.workers].filter((name) => !Object.hasOwn(desired.workers, name) && name !== 'wizardgang-portfolio-staging');
  assert.deepEqual(old.sort(), ['wizardgang-architecture-demo', 'wizardgang-portfolio', 'wizardgangprod']);
  for (const name of old) assert.match(runbook, new RegExp(`\`${name}\` → \`(?:${Object.keys(desired.workers).join('|')})\``));
  const leftover = [...inventory.d1, ...inventory.r2].filter((name) => !desired.d1.includes(name) && !desired.r2.some((b) => b.name === name));
  for (const name of leftover) assert.ok(runbook.includes(`delete ${name}`), `the runbook must retire ${name}`);
  assert.match(runbook, /gh secret delete CLOUDFLARE_API_TOKEN --repo \S+`, then `gh secret delete CLOUDFLARE_ACCOUNT_ID --repo /);
});

test('the step 3.4 lifecycle rules equal config/cloudflare.json', () => {
  const block = /<<'JSON'\n([\s\S]*?)\n\s*JSON\n/.exec(runbook);
  assert.ok(block, 'step 3.4 must carry the lifecycle file');
  const { rules } = JSON.parse(block[1]);
  const [bucket] = desired.r2;
  assert.deepEqual(normalizeLifecycle(rules).sort(), [...expectedCloudflareState(desired).lifecycle[bucket.name]].sort());
});

test('the starting drift counts match the recorded inventory', async () => {
  const lines = [];
  await runVerifyCloudflare({ env: ENV, fetchImpl: fakeFetch(recorded), log: () => {}, error: (text) => lines.push(text) });
  const count = (heading) => lines.find((line) => line.startsWith(`${heading} (`))?.match(/\((\d+)\)/)[1];
  assert.ok(runbook.includes(`(${count('Missing')} missing, ${count('Unexpected')} unexpected and ${count('Mismatched')} mismatched items)`));
});

test('the runbook holds no account ID, binding ID or token value', () => {
  assert.doesNotMatch(runbook, /\b[0-9a-f]{32}\b/i);
  assert.doesNotMatch(runbook, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  assert.doesNotMatch(runbook, /[A-Za-z0-9_-]{40,}/);
  assert.doesNotMatch(runbook, /--value\b/);
});

test('the repository contract requires the runbook and its tests', () => {
  const copy = mkdtempSync(join(tmpdir(), 'baseline-runbook-'));
  try {
    cpSync(root, copy, { recursive: true, filter: (source) => !/^(?:\.git|node_modules)(?:[\\/]|$)/.test(relative(root, source)) });
    assert.deepEqual(validateRepositoryAt(copy), []);
    for (const path of [RUNBOOK, 'tests/cloudflare-runbook.test.mjs']) {
      rmSync(join(copy, path));
      assert.ok(validateRepositoryAt(copy).includes(`missing or empty repository authority: ${path}`), `${path} must be required`);
      cpSync(join(root, path), join(copy, path));
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
