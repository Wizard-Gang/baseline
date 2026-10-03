import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGh } from '../scripts/cloudflare-token-targets.mjs';
import { EXIT, runRotateCloudflareToken } from '../scripts/rotate-cloudflare-token.mjs';
import { REPOSITORIES, convergedRepos, fakeGh, recordedRepos } from './fixtures/fake-gh.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = 'SouthernGentlemen/wizardgang-architecture-demo';
const VALUE = 'cf-rotation-value-must-never-print-0123';
const ACCOUNT = 'e'.repeat(32);

function cloudflare(status = 'active', seen = []) {
  return async (url, init) => {
    seen.push({ url, init });
    return { ok: true, json: async () => ({ success: true, result: { status } }) };
  };
}

async function rotate({ repos = convergedRepos(), fail = [], argv = ['--apply'], input = `${VALUE}\n`, stdin, fetchImpl = cloudflare(), env = {} } = {}) {
  const gh = fakeGh({ repos, fail });
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

test('apply writes each declared production environment over stdin and re-reads updatedAt', async () => {
  const seen = [];
  const result = await rotate({ fetchImpl: cloudflare('active', seen), env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT } });
  assert.equal(result.code, EXIT.rotated, result.err);
  assert.deepEqual(result.sets.map((call) => call.argv), REPOSITORIES.map((repository) =>
    ['secret', 'set', 'CLOUDFLARE_API_TOKEN', '--repo', repository, '--env', 'production']));
  assert.ok(result.sets.every((call) => call.stdin === VALUE), 'stdin carries exactly the value, without the newline');
  for (const repository of REPOSITORIES) {
    assert.match(result.out, new RegExp(`Updated ${repository} — production environment: updatedAt 2026-10-03T12:00:0\\dZ`));
    const at = result.calls.findIndex((call) => call.argv[1] === 'set' && call.argv.includes(repository));
    assert.deepEqual(result.calls[at + 1].argv, ['secret', 'list', '--repo', repository, '--env', 'production', '--json', 'name,updatedAt']);
  }
  assert.match(result.out, /Rotation complete for all 4 target\(s\)\.$/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/tokens/verify`);
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${VALUE}`);
  assert.ok(!result.out.includes(ACCOUNT) && !result.err.includes(ACCOUNT));
});

test('a repository-level token is reported as drift and never written', async () => {
  const result = await rotate({ repos: recordedRepos(), fetchImpl: cloudflare(), argv: ['--apply'] });
  assert.equal(result.code, EXIT.rotated, result.err);
  assert.match(result.err, /repository-level CLOUDFLARE_API_TOKEN is outside the production environment; it is reported and never updated/);
  assert.ok(result.sets.every((call) => call.argv.includes('--env')), 'every write names an environment');
  assert.ok(result.sets.some((call) => call.argv.includes(DEMO)), 'the demo production environment is written');
  assert.equal(result.state.repos[DEMO].secrets.CLOUDFLARE_API_TOKEN, '2026-08-31T22:10:07Z', 'the repository-level secret is untouched');
  assert.ok(result.state.repos[DEMO].environments.production.CLOUDFLARE_API_TOKEN);
});

test('without --apply nothing is read from stdin or written', async () => {
  let read = false;
  const stdin = Readable.from((function* () { read = true; yield VALUE; })());
  const result = await rotate({ repos: recordedRepos(), argv: [], stdin });
  assert.equal(result.code, EXIT.rotated);
  assert.equal(read, false);
  assert.deepEqual(result.sets, []);
  assert.match(result.out, /Plan only; nothing was read from stdin or written/);
  assert.match(result.out, new RegExp(`- ${DEMO} — production environment \\(updatedAt none\\)`));
});

test('a failed write fails the run but the other targets are still written', async () => {
  const result = await rotate({ fail: ['set:Wizard-Gang/SharkTank:production'] });
  assert.equal(result.code, EXIT.writeFailed);
  assert.match(result.err, /error: write failed for Wizard-Gang\/SharkTank — production environment: HTTP 403/);
  assert.match(result.err, /Rotation finished with 1 failure\(s\)/);
  assert.equal(result.sets.length, 4);
});

test('a failed or stale re-read fails the run', async () => {
  let result = await rotate({ fail: ['relist:Wizard-Gang/Hexframe:production'] });
  assert.equal(result.code, EXIT.writeFailed);
  assert.match(result.err, /error: re-read failed for Wizard-Gang\/Hexframe — production environment: cannot read/);
  result = await rotate({ fail: ['stale:Wizard-Gang/WizardGang:production'] });
  assert.equal(result.code, EXIT.writeFailed);
  assert.match(result.err, /re-read of Wizard-Gang\/WizardGang — production environment shows no new updatedAt \(before 2026-08-31T22:10:05Z, after 2026-08-31T22:10:05Z\)/);
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
  const skipped = await rotate({ argv: ['--apply', '--skip-verify'], fetchImpl: () => assert.fail('no Cloudflare call') });
  assert.equal(skipped.code, EXIT.rotated);
});

test('a missing production environment, denied read or bad usage writes nothing', async () => {
  const repos = convergedRepos();
  repos['Wizard-Gang/Hexframe'].environments = {};
  let result = await rotate({ repos });
  assert.equal(result.code, EXIT.failure);
  assert.match(result.err, /create the production environment in Wizard-Gang\/Hexframe first; nothing was written/);
  assert.deepEqual(result.sets, []);
  result = await rotate({ fail: [`environments:${DEMO}`] });
  assert.equal(result.code, EXIT.readAccess);
  assert.deepEqual(result.sets, []);
  for (const argv of [['--owner', 'Wizard-Gang'], ['--skip-verify'], ['--apply', VALUE]]) {
    result = await rotate({ argv });
    assert.equal(result.code, EXIT.usage, argv.join(' '));
    assert.deepEqual(result.calls, []);
  }
});
