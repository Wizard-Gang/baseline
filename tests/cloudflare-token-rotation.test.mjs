import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGh } from '../scripts/cloudflare-token-targets.mjs';
import { EXIT, parseArguments, runRotateCloudflareToken } from '../scripts/rotate-cloudflare-token.mjs';
import { ACCOUNT_ID, DEMO, DEPLOY_DATE, REPOSITORIES, convergedRepos, fakeGh, recordedRepos } from './fixtures/fake-gh.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALUE = 'cf-rotation-value-must-never-print-0123';
const ACCOUNT = 'f'.repeat(32);
const DEPLOY = ['--credential', 'wg-cloudflare-deploy'];
const DEPLOYED = [...REPOSITORIES];

function cloudflare(status = 'active', seen = []) {
  return async (url, init) => {
    seen.push({ url, init });
    return { ok: true, json: async () => ({ success: true, result: { status } }) };
  };
}

async function rotate({ repos = convergedRepos(), fail = [], variableValues = {}, argv = [...DEPLOY, '--apply'], input = `${VALUE}\n`, stdin, fetchImpl = cloudflare(), env = {} } = {}) {
  const gh = fakeGh({ repos, fail, variableValues });
  const out = [];
  const err = [];
  try {
    const code = await runRotateCloudflareToken({ argv, env: { ...gh.env, ...env }, root, gh: createGh({ env: { ...gh.env, ...env } }),
      stdin: stdin ?? Readable.from([input]), fetchImpl, log: (text) => out.push(text), error: (text) => err.push(text) });
    const calls = gh.calls();
    const printed = [...out, ...err].join('\n');
    assert.ok(!printed.includes(VALUE), 'the value must never be printed');
    for (const call of calls) {
      assert.ok(!call.argv.some((arg) => arg.includes(VALUE)), 'the value must never be an argument');
      assert.equal(call.envHasStdin, false, 'the value must never be in the environment');
    }
    return { code, out: out.join('\n'), err: err.join('\n'), calls, sets: calls.filter((call) => call.argv[1] === 'set'), state: gh.state() };
  } finally {
    gh.cleanup();
  }
}

const tokenAt = (state, repository, environment = 'production') => state.repos[repository].environments[environment]?.secrets.CLOUDFLARE_API_TOKEN;

test('wg-cloudflare-deploy writes all four production environments over stdin and re-reads them', async () => {
  const seen = [];
  const result = await rotate({ fetchImpl: cloudflare('active', seen), env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT } });
  assert.equal(result.code, EXIT.rotated, result.err);
  assert.deepEqual(result.sets.map((call) => call.argv), DEPLOYED.map((repository) =>
    ['secret', 'set', 'CLOUDFLARE_API_TOKEN', '--repo', repository, '--env', 'production']));
  assert.ok(result.sets.every((call) => call.stdin === VALUE), 'stdin carries exactly the value, without the newline');
  for (const repository of DEPLOYED) {
    assert.match(result.out, new RegExp(`Updated ${repository} — production environment CLOUDFLARE_API_TOKEN: updatedAt 2026-10-05T12:00:0\\dZ`));
    const at = result.calls.findIndex((call) => call.argv[1] === 'set' && call.argv.includes(repository));
    assert.deepEqual(result.calls[at + 1].argv, ['secret', 'list', '--repo', repository, '--env', 'production', '--json', 'name,updatedAt']);
  }
  assert.match(result.out, /^Targets for wg-cloudflare-deploy /);
  assert.match(result.out, /Rotation of wg-cloudflare-deploy complete for all 4 target\(s\)\.$/);
  assert.notEqual(tokenAt(result.state, DEMO), DEPLOY_DATE, 'the demo takes the deploy token');
  assert.ok(!result.calls.some((call) => call.argv[0] === 'variable' && call.argv[1] === 'get'), 'the shell account ID wins');
  assert.deepEqual(result.state.repos[DEMO].environments['git-demo'], convergedRepos()[DEMO].environments['git-demo']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/tokens/verify`);
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${VALUE}`);
  assert.ok(!result.out.includes(ACCOUNT) && !result.err.includes(ACCOUNT));
});

test('without CLOUDFLARE_ACCOUNT_ID, the targets\' account ID variable verifies the account-owned token', async () => {
  const seen = [];
  const result = await rotate({ fetchImpl: cloudflare('active', seen) });
  assert.equal(result.code, EXIT.rotated, result.err);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/tokens/verify`);
  assert.deepEqual(result.calls.filter((call) => call.argv[1] === 'get').map((call) => call.argv), DEPLOYED.map((repository) =>
    ['variable', 'get', 'CLOUDFLARE_ACCOUNT_ID', '--repo', repository, '--env', 'production']));
  assert.ok(!result.out.includes(ACCOUNT_ID) && !result.err.includes(ACCOUNT_ID));
});

test('disagreeing or absent account ID variables refuse before stdin is read', async () => {
  for (const [options, problem] of [
    [{ variableValues: { 'Wizard-Gang/Hexframe:production:CLOUDFLARE_ACCOUNT_ID': ACCOUNT } }, /variables disagree/],
    [{ repos: recordedRepos() }, /no target holds a CLOUDFLARE_ACCOUNT_ID variable; set CLOUDFLARE_ACCOUNT_ID in the shell/],
  ]) {
    let read = false;
    const stdin = Readable.from((function* () { read = true; yield VALUE; })());
    const result = await rotate({ ...options, stdin, fetchImpl: () => assert.fail('no Cloudflare call') });
    assert.equal(result.code, EXIT.failure);
    assert.match(result.err, problem);
    assert.equal(read, false);
    assert.deepEqual(result.sets, []);
  }
});

test('recorded drift is reported and never written; only the mapped token secret changes', async () => {
  const before = recordedRepos();
  const result = await rotate({ repos: before, env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT } });
  assert.equal(result.code, EXIT.rotated, result.err);
  assert.match(result.err, /^Registry drift, reported and never written \(9\):/);
  assert.match(result.err, /repository-level secret GIT_DEMO_PR_TOKEN is outside the registry/);
  assert.match(result.err, /stores CLOUDFLARE_ACCOUNT_ID as a secret; the registry makes it a variable/);
  assert.ok(result.sets.every((call) => call.argv[2] === 'CLOUDFLARE_API_TOKEN' && call.argv.includes('--env')));
  for (const [repository, repo] of Object.entries(before)) {
    const after = result.state.repos[repository];
    assert.deepEqual(after.secrets, repo.secrets);
    assert.deepEqual(after.variables, repo.variables);
    assert.equal(after.environments.production.secrets.CLOUDFLARE_ACCOUNT_ID, repo.environments.production.secrets.CLOUDFLARE_ACCOUNT_ID);
  }
});

test('an unknown, non-rotatable or missing credential is a usage error before any read or write', async () => {
  for (const credential of ['wg-cloudflare-demo', 'wg-cloudflare-unknown', 'wg-cloudflare-billing', 'wg-cloudflare-audit', 'wg-github-app', VALUE]) {
    const result = await rotate({ argv: ['--credential', credential, '--apply'] });
    assert.equal(result.code, EXIT.usage, credential);
    assert.deepEqual(result.calls, [], 'nothing is read or written');
    assert.match(result.err, /one of wg-cloudflare-deploy\. Nothing was read or written\./);
  }
  for (const argv of [['--apply'], [], ['--credential'], [...DEPLOY, ...DEPLOY], ['--owner', 'Wizard-Gang', ...DEPLOY], [...DEPLOY, '--skip-verify'], [...DEPLOY, '--apply', VALUE]]) {
    const result = await rotate({ argv });
    assert.equal(result.code, EXIT.usage, argv.join(' '));
    assert.deepEqual(result.calls, []);
  }
  assert.deepEqual(parseArguments([...DEPLOY, '--apply', '--skip-verify']), { credential: 'wg-cloudflare-deploy', apply: true, skipVerify: true });
});

test('without --apply nothing is read from stdin or written', async () => {
  let read = false;
  const stdin = Readable.from((function* () { read = true; yield VALUE; })());
  const result = await rotate({ repos: recordedRepos(), argv: DEPLOY, stdin });
  assert.equal(result.code, EXIT.rotated);
  assert.equal(read, false);
  assert.deepEqual(result.sets, []);
  assert.match(result.out, /Plan only; nothing was read from stdin or written/);
  assert.match(result.out, new RegExp(`- Wizard-Gang/Hexframe — production environment CLOUDFLARE_API_TOKEN \\(updatedAt ${DEPLOY_DATE}\\)`));
});

test('a failed write fails the run but the other targets are still written', async () => {
  const result = await rotate({ fail: ['set:Wizard-Gang/SharkTank:production'] });
  assert.equal(result.code, EXIT.writeFailed);
  assert.match(result.err, /error: write failed for Wizard-Gang\/SharkTank — production environment CLOUDFLARE_API_TOKEN: HTTP 403/);
  assert.match(result.err, /Rotation finished with 1 failure\(s\)/);
  assert.equal(result.sets.length, 4);
});

test('a failed or stale re-read fails the run', async () => {
  let result = await rotate({ fail: ['relist:Wizard-Gang/Hexframe:production'] });
  assert.equal(result.code, EXIT.writeFailed);
  assert.match(result.err, /error: re-read failed for Wizard-Gang\/Hexframe — production environment CLOUDFLARE_API_TOKEN: cannot read/);
  result = await rotate({ fail: ['stale:Wizard-Gang/WizardGang:production'] });
  assert.equal(result.code, EXIT.writeFailed);
  assert.match(result.err, new RegExp(`re-read of Wizard-Gang/WizardGang — production environment CLOUDFLARE_API_TOKEN shows no new updatedAt \\(before ${DEPLOY_DATE}, after ${DEPLOY_DATE}\\)`));
});

test('missing, malformed or terminal input and an inactive token write nothing', async () => {
  for (const input of ['', '\n', 'short', `${VALUE} extra`, `${VALUE}\n${VALUE}\n`]) {
    const result = await rotate({ input });
    assert.equal(result.code, EXIT.usage, JSON.stringify(input));
    assert.deepEqual(result.sets, []);
  }
  const tty = Object.assign(Readable.from([VALUE]), { isTTY: true });
  assert.equal((await rotate({ stdin: tty })).code, EXIT.usage);
  for (const fetchImpl of [cloudflare('disabled'), async () => { throw new Error(`network ${VALUE}`); }]) {
    const result = await rotate({ fetchImpl });
    assert.equal(result.code, EXIT.failure);
    assert.deepEqual(result.sets, []);
  }
  const skipped = await rotate({ argv: [...DEPLOY, '--apply', '--skip-verify'], fetchImpl: () => assert.fail('no Cloudflare call') });
  assert.equal(skipped.code, EXIT.rotated);
});

test('a missing mapped environment or a denied read writes nothing; an unmapped one does not block', async () => {
  const repos = convergedRepos();
  repos['Wizard-Gang/Hexframe'].environments = {};
  let result = await rotate({ repos });
  assert.equal(result.code, EXIT.failure);
  assert.match(result.err, /create the production environment in Wizard-Gang\/Hexframe first; nothing was written/);
  assert.deepEqual(result.sets, []);
  const unmapped = convergedRepos();
  delete unmapped[DEMO].environments['git-demo'];
  result = await rotate({ repos: unmapped });
  assert.equal(result.code, EXIT.rotated, result.err);
  assert.equal(result.sets.length, 4);
  result = await rotate({ fail: [`environments:${DEMO}`] });
  assert.equal(result.code, EXIT.readAccess);
  assert.deepEqual(result.sets, []);
});
