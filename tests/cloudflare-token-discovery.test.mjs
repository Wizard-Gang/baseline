import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadCloudflareDesiredState } from '../scripts/cloudflare-desired-state.mjs';
import { createGh, declaredTokenTargets } from '../scripts/cloudflare-token-targets.mjs';
import { EXIT, runDiscoverTokenTargets } from '../scripts/discover-cloudflare-token-targets.mjs';
import { REPOSITORIES, convergedRepos, fakeGh, recordedRepos } from './fixtures/fake-gh.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = 'SouthernGentlemen/wizardgang-architecture-demo';

function discover(options = {}, { argv = [], at = root } = {}) {
  const gh = fakeGh(options);
  const out = [];
  const err = [];
  try {
    const code = runDiscoverTokenTargets({ argv, env: gh.env, root: at, gh: createGh({ env: gh.env }),
      log: (text) => out.push(text), error: (text) => err.push(text) });
    return { code, out, err: err.join('\n'), calls: gh.calls() };
  } finally {
    gh.cleanup();
  }
}

test('targets are exactly the declared repositories and their production environments', () => {
  const desired = loadCloudflareDesiredState(root);
  assert.deepEqual(declaredTokenTargets(desired), Object.entries(desired.workers)
    .map(([worker, { repository }]) => ({ worker, repository, environment: 'production' })));
  assert.deepEqual(declaredTokenTargets(desired).map((target) => target.repository).sort(), [...REPOSITORIES].sort());
});

test('a converged account lists every target with no drift, using read-only calls', () => {
  const result = discover();
  assert.equal(result.code, EXIT.ready);
  assert.equal(result.err, '');
  assert.deepEqual(result.out, [
    'wizardgang\tWizard-Gang/WizardGang\tproduction\t2026-08-31T22:10:05Z',
    `demo\t${DEMO}\tproduction\t2026-08-31T22:10:05Z`,
    'sharktank\tWizard-Gang/SharkTank\tproduction\t2026-08-31T22:10:05Z',
    'hexframe\tWizard-Gang/Hexframe\tproduction\t2026-08-31T22:10:05Z',
  ]);
  for (const { argv } of result.calls) {
    assert.ok(['auth status', 'secret list', 'api'].some((command) => argv.join(' ').startsWith(command)), argv.join(' '));
  }
});

test('repositories outside the config are never read, even when they hold the token', () => {
  const repos = { ...convergedRepos(), 'Wizard-Gang/YarReader': { secrets: { CLOUDFLARE_API_TOKEN: '2026-08-01T00:00:00Z' }, environments: {} } };
  const result = discover({ repos });
  assert.equal(result.code, EXIT.ready);
  assert.ok(result.calls.every(({ argv }) => !argv.join(' ').includes('YarReader')));
});

test('the recorded demo reports its repository-level token and empty production environment as drift', () => {
  const result = discover({ repos: recordedRepos() });
  assert.equal(result.code, EXIT.drift);
  assert.ok(result.out.includes(`demo\t${DEMO}\tproduction\tmissing`));
  assert.deepEqual(result.err.split('\n'), [
    'Drift (2):',
    `- ${DEMO}: repository-level CLOUDFLARE_API_TOKEN is outside the production environment; it is reported and never updated`,
    `- ${DEMO}: the production environment has no CLOUDFLARE_API_TOKEN`,
  ]);
});

test('a missing production environment and a token in another environment are drift', () => {
  const repos = convergedRepos();
  repos['Wizard-Gang/Hexframe'].environments = { staging: { CLOUDFLARE_API_TOKEN: '2026-08-01T00:00:00Z' } };
  repos['Wizard-Gang/SharkTank'].environments.preview = { CLOUDFLARE_API_TOKEN: '2026-08-01T00:00:00Z' };
  const result = discover({ repos });
  assert.equal(result.code, EXIT.drift);
  assert.ok(result.out.includes('hexframe\tWizard-Gang/Hexframe\tproduction\tmissing'));
  assert.ok(result.err.includes('- Wizard-Gang/Hexframe: the production environment does not exist'));
  assert.ok(result.err.includes('- Wizard-Gang/Hexframe: the staging environment holds CLOUDFLARE_API_TOKEN'));
  assert.ok(result.err.includes('- Wizard-Gang/SharkTank: the preview environment holds CLOUDFLARE_API_TOKEN'));
});

test('missing gh credentials and denied reads exit distinctly', () => {
  assert.equal(discover({ authenticated: false }).code, EXIT.usage);
  for (const fail of [`list:${DEMO}`, `list:${DEMO}:production`, `environments:${DEMO}`]) {
    const result = discover({ fail: [fail] });
    assert.equal(result.code, EXIT.readAccess, fail);
    assert.match(result.err, /^GitHub read access failed: cannot read .*HTTP 403/);
  }
  const missing = runDiscoverTokenTargets({ argv: [], env: { PATH: '/nonexistent' }, root, log: () => {}, error: () => {} });
  assert.equal(missing, EXIT.usage);
});

test('unknown arguments are usage errors and an invalid config reads nothing', () => {
  assert.equal(discover({}, { argv: ['--owner', 'Wizard-Gang'] }).code, EXIT.usage);
  const at = mkdtempSync(join(tmpdir(), 'discover-config-'));
  try {
    cpSync(join(root, 'config'), join(at, 'config'), { recursive: true });
    writeFileSync(join(at, 'config/cloudflare.json'), JSON.stringify({ schemaVersion: 1 }));
    const result = discover({}, { at });
    assert.equal(result.code, EXIT.failure);
    assert.deepEqual(result.calls, []);
  } finally {
    rmSync(at, { recursive: true, force: true });
  }
});
