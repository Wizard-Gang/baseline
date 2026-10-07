import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadCloudflareDesiredState } from '../scripts/cloudflare-desired-state.mjs';
import { configRepositories, createGh, credentialTargets, registryTargets, rotatableCredentials } from '../scripts/cloudflare-token-targets.mjs';
import { EXIT, runDiscoverTokenTargets } from '../scripts/discover-cloudflare-token-targets.mjs';
import { loadSecretRegistry } from '../scripts/secret-registry.mjs';
import { DEMO, DEMO_DATE, DEPLOY_DATE, REPOSITORIES, convergedRepos, fakeGh, recordedRepos } from './fixtures/fake-gh.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = loadSecretRegistry(root);
const repositories = configRepositories(loadCloudflareDesiredState(root));
const [WG, , SHARK, HEX] = REPOSITORIES;

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

test('targets are the registry GitHub-environment entries, every deploy token on wg-cloudflare-deploy', () => {
  assert.deepEqual(repositories, [...REPOSITORIES]);
  const row = ({ repository, environment, kind, name, credential }) => `${repository} ${environment} ${kind} ${name} ${credential}`;
  assert.deepEqual(registryTargets(registry, repositories).map(row), [
    `${WG} production secret CLOUDFLARE_API_TOKEN wg-cloudflare-deploy`, `${WG} production variable CLOUDFLARE_ACCOUNT_ID null`,
    `${DEMO} git-demo secret APP_PRIVATE_KEY wg-github-app`, `${DEMO} git-demo variable APP_ID null`,
    `${DEMO} production secret CLOUDFLARE_API_TOKEN wg-cloudflare-deploy`, `${DEMO} production variable CLOUDFLARE_ACCOUNT_ID null`,
    `${SHARK} production secret CLOUDFLARE_API_TOKEN wg-cloudflare-deploy`, `${SHARK} production variable CLOUDFLARE_ACCOUNT_ID null`,
    `${HEX} production secret CLOUDFLARE_API_TOKEN wg-cloudflare-deploy`, `${HEX} production variable CLOUDFLARE_ACCOUNT_ID null`,
  ]);
  assert.deepEqual(rotatableCredentials(registry), ['wg-cloudflare-deploy']);
  const where = (credential) => credentialTargets(registry, repositories, credential)?.map((target) => `${target.repository}:${target.environment}`);
  assert.deepEqual(where('wg-cloudflare-deploy'), [`${WG}:production`, `${DEMO}:production`, `${SHARK}:production`, `${HEX}:production`]);
  for (const credential of ['wg-cloudflare-demo', 'wg-cloudflare-billing', 'wg-cloudflare-audit', 'wg-github-app', 'wg-cloudflare-unknown', '']) {
    assert.equal(credentialTargets(registry, repositories, credential), null, credential);
  }
});

test('a converged account lists every registry entry with no drift, using read-only calls', () => {
  const result = discover();
  assert.equal(result.code, EXIT.ready, result.err);
  assert.equal(result.err, '');
  const account = '2026-10-04T19:00:00Z';
  assert.deepEqual(result.out, [
    `${WG}\tproduction\tsecret\tCLOUDFLARE_API_TOKEN\twg-cloudflare-deploy\t${DEPLOY_DATE}`, `${WG}\tproduction\tvariable\tCLOUDFLARE_ACCOUNT_ID\t-\t${account}`,
    `${DEMO}\tgit-demo\tsecret\tAPP_PRIVATE_KEY\twg-github-app\t2026-10-04T19:10:00Z`, `${DEMO}\tgit-demo\tvariable\tAPP_ID\t-\t2026-10-04T19:10:00Z`,
    `${DEMO}\tproduction\tsecret\tCLOUDFLARE_API_TOKEN\twg-cloudflare-deploy\t${DEMO_DATE}`, `${DEMO}\tproduction\tvariable\tCLOUDFLARE_ACCOUNT_ID\t-\t${account}`,
    `${SHARK}\tproduction\tsecret\tCLOUDFLARE_API_TOKEN\twg-cloudflare-deploy\t${DEPLOY_DATE}`, `${SHARK}\tproduction\tvariable\tCLOUDFLARE_ACCOUNT_ID\t-\t${account}`,
    `${HEX}\tproduction\tsecret\tCLOUDFLARE_API_TOKEN\twg-cloudflare-deploy\t${DEPLOY_DATE}`, `${HEX}\tproduction\tvariable\tCLOUDFLARE_ACCOUNT_ID\t-\t${account}`,
  ]);
  for (const { argv } of result.calls) {
    assert.ok(['auth status', 'secret list', 'variable list', 'api'].some((command) => argv.join(' ').startsWith(command)), argv.join(' '));
    if (argv[1] === 'list') assert.deepEqual(argv.slice(-2), ['--json', 'name,updatedAt'], 'names and updatedAt only, never values');
  }
});

test('repositories outside the config are never read, even when they hold the token', () => {
  const repos = { ...convergedRepos(), 'Wizard-Gang/YarReader': { secrets: { CLOUDFLARE_API_TOKEN: '2026-08-01T00:00:00Z' }, variables: {}, environments: {} } };
  const result = discover({ repos });
  assert.equal(result.code, EXIT.ready);
  assert.ok(result.calls.every(({ argv }) => !argv.join(' ').includes('YarReader')));
});

test('the recorded 2026-10-04 state reports the account ID secrets and every unregistered entry as drift', () => {
  const result = discover({ repos: recordedRepos() });
  assert.equal(result.code, EXIT.drift);
  assert.ok(result.out.includes(`${DEMO}\tgit-demo\tsecret\tAPP_PRIVATE_KEY\twg-github-app\tmissing`));
  assert.ok(result.out.includes(`${HEX}\tproduction\tvariable\tCLOUDFLARE_ACCOUNT_ID\t-\tmissing`));
  const wrongKind = (repository) => `- ${repository}: the production environment stores CLOUDFLARE_ACCOUNT_ID as a secret; the registry makes it a variable`;
  assert.deepEqual(result.err.split('\n'), [
    'Drift (9):',
    wrongKind(WG),
    `- ${DEMO}: repository-level secret GIT_DEMO_PR_TOKEN is outside the registry; it is reported and never updated`,
    `- ${DEMO}: the git-demo environment does not exist`,
    wrongKind(DEMO),
    `- ${DEMO}: the production environment holds variable CLOUDFLARE_DO_NAMESPACE, which is not in the registry`,
    `- ${SHARK}: repository-level variable PRODUCTION_DEPLOY_ENABLED is outside the registry; it is reported and never updated`,
    wrongKind(SHARK),
    wrongKind(HEX),
    `- ${HEX}: the production environment holds variable PRODUCTION_HOST, which is not in the registry`,
  ]);
});

test('missing environments and entries, other environments, unknown names and both wrong kinds are drift', () => {
  const repos = convergedRepos();
  repos[HEX].environments = { staging: { secrets: { CLOUDFLARE_API_TOKEN: '2026-08-01T00:00:00Z' }, variables: {} } };
  repos[SHARK].environments.preview = { secrets: {}, variables: { CLOUDFLARE_ACCOUNT_ID: '2026-08-01T00:00:00Z' } };
  repos[SHARK].environments.production.secrets = { CLOUDFLARE_DEPLOY_TOKEN: '2026-08-01T00:00:00Z' };
  repos[WG].environments.production = { secrets: {}, variables: { CLOUDFLARE_API_TOKEN: '2026-08-01T00:00:00Z', CLOUDFLARE_ACCOUNT_ID: '2026-08-01T00:00:00Z' } };
  repos[DEMO].variables.CLOUDFLARE_ACCOUNT_ID = '2026-08-01T00:00:00Z';
  repos[DEMO].environments.production.secrets.CLOUDFLARE_ACCOUNT_ID = '2026-08-01T00:00:00Z';
  const result = discover({ repos });
  assert.equal(result.code, EXIT.drift);
  assert.ok(result.out.includes(`${HEX}\tproduction\tsecret\tCLOUDFLARE_API_TOKEN\twg-cloudflare-deploy\tmissing`));
  for (const line of [
    `${WG}: the production environment stores CLOUDFLARE_API_TOKEN as a variable; the registry makes it a secret`,
    `${DEMO}: repository-level variable CLOUDFLARE_ACCOUNT_ID is outside the registry`,
    `${SHARK}: the preview environment is not a registry environment but holds variable CLOUDFLARE_ACCOUNT_ID`,
    `${SHARK}: the production environment has no registered secret CLOUDFLARE_API_TOKEN`,
    `${SHARK}: the production environment holds secret CLOUDFLARE_DEPLOY_TOKEN, which is not in the registry`,
    `${HEX}: the production environment does not exist`,
    `${HEX}: the staging environment is not a registry environment but holds secret CLOUDFLARE_API_TOKEN`,
    `${DEMO}: the production environment also holds CLOUDFLARE_ACCOUNT_ID as a secret; the registry makes it a variable, so delete the secret`,
  ]) assert.ok(result.err.includes(`- ${line}`), line);
  assert.match(result.err, /^Drift \(8\):/);
});

test('missing gh credentials and denied reads exit distinctly', () => {
  assert.equal(discover({ authenticated: false }).code, EXIT.usage);
  for (const fail of [`list:${DEMO}`, `vars:${DEMO}`, `list:${DEMO}:production`, `vars:${DEMO}:git-demo`, `environments:${DEMO}`]) {
    const result = discover({ fail: [fail] });
    assert.equal(result.code, EXIT.readAccess, fail);
    assert.match(result.err, /^GitHub read access failed: cannot read .*HTTP 403/);
  }
  const missing = runDiscoverTokenTargets({ argv: [], env: { PATH: '/nonexistent' }, root, log: () => {}, error: () => {} });
  assert.equal(missing, EXIT.usage);
});

test('unknown arguments are usage errors and an invalid authority reads nothing', () => {
  assert.equal(discover({}, { argv: ['--owner', 'Wizard-Gang'] }).code, EXIT.usage);
  for (const [file, body] of [['config/cloudflare.json', { schemaVersion: 1 }], ['config/secrets.json', { schemaVersion: 1, entries: [], exceptions: [] }]]) {
    const at = mkdtempSync(join(tmpdir(), 'discover-config-'));
    try {
      cpSync(join(root, 'config'), join(at, 'config'), { recursive: true });
      cpSync(join(root, 'package.json'), join(at, 'package.json'));
      writeFileSync(join(at, file), JSON.stringify(body));
      const result = discover({}, { at });
      assert.equal(result.code, EXIT.failure, file);
      assert.match(result.err, new RegExp(`- ${file}: `));
      assert.deepEqual(result.calls, []);
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  }
});
