import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DESIRED } from '../platform/conformance/desired.mjs';
import { checkIdentity, checkTraffic, hostFor, pollVersion, run } from '../platform/deploy/verify.mjs';

const COMMIT = 'a'.repeat(40);
const VERSION_ID = '0b5ef3c1-6f0e-4d4e-9a35-2d1c3f9e8a11';
const deployLine = (fields = {}) => JSON.stringify({ type: 'deploy', version: 1, worker_name: 'hexframe', version_id: VERSION_ID, ...fields });
const status = (versions) => ({ id: 'deployment', versions });
const cli = fileURLToPath(new URL('../platform/deploy/verify.mjs', import.meta.url));

/** A fake public host: each call returns the next scripted response, repeating the last one. */
function fakeHost(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return { status: next.status ?? 200, text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)) };
  };
  let clock = 0;
  return { calls, fetch, now: () => clock, sleep: async (ms) => { clock += ms; }, log: () => {} };
}

test('the host comes only from the vendored desired state', () => {
  for (const [label, worker] of Object.entries(DESIRED.workers)) assert.equal(hostFor(label), worker.host);
  for (const label of ['nope', 'toString', '__proto__', '']) assert.throws(() => hostFor(label), /unknown Worker/);
});

test('the deployed version must serve 100% of traffic', () => {
  const ok = { label: 'hexframe', deployOutput: `{"type":"wrangler-session"}\n${deployLine()}\n`, status: status([{ version_id: VERSION_ID, percentage: 100 }]) };
  assert.deepEqual(checkTraffic(ok), []);
  const failing = [
    [{ status: status([{ version_id: VERSION_ID, percentage: 90 }, { version_id: 'old', percentage: 10 }]) }, /exactly one version; found 2/],
    [{ status: status([{ version_id: VERSION_ID, percentage: 99 }]) }, /99% of traffic/],
    [{ status: status([{ version_id: VERSION_ID, percentage: '100' }]) }, /"100"% of traffic/],
    [{ status: status([{ version_id: 'previous', percentage: 100 }]) }, /active version "previous" is not the deployed/],
    [{ status: status([]) }, /found 0/],
    [{ status: [] }, /found 0/],
    [{ deployOutput: '' }, /exactly one deploy record; found 0/],
    [{ deployOutput: `${deployLine()}\n${deployLine()}` }, /found 2/],
    [{ deployOutput: 'not json' }, /line 1 is not JSON/],
    [{ deployOutput: deployLine({ worker_name: 'wizardgangprod' }) }, /names Worker "wizardgangprod"/],
    [{ deployOutput: deployLine({ version_id: '' }) }, /no version_id/],
  ];
  for (const [change, pattern] of failing) {
    assert.match(checkTraffic({ ...ok, ...change }).join('\n'), pattern, JSON.stringify(change));
  }
});

test('the public identity must match app, version and commit exactly', () => {
  const expected = { label: 'hexframe', version: '1.4.0', commit: COMMIT };
  assert.deepEqual(checkIdentity({ app: 'hexframe', version: '1.4.0', commit: COMMIT, extra: true }, expected), []);
  assert.equal(checkIdentity({ app: 'hexframe', version: '1.3.9', commit: COMMIT }, expected).length, 1);
  assert.equal(checkIdentity({ app: 'demo', version: '1.4.0', commit: 'b'.repeat(40) }, expected).length, 2);
  assert.equal(checkIdentity(null, expected).length, 3);
  assert.equal(checkIdentity(['hexframe'], expected).length, 3);
});

test('polling waits through stale, failing and challenged responses until the identity matches', async () => {
  const live = { app: 'hexframe', version: '1.4.0', commit: COMMIT };
  const host = fakeHost([
    new Error('fetch failed'),
    { status: 403, body: '<html>challenge</html>' },
    { body: 'not json' },
    { body: { ...live, version: '1.3.9', commit: 'b'.repeat(40) } },
    { body: live },
  ]);
  assert.deepEqual(await pollVersion({ label: 'hexframe', version: '1.4.0', commit: COMMIT, ...host }), []);
  assert.equal(host.calls.length, 5);
  assert.equal(host.calls[0].url, `https://hexframe.wizardgang.ai/version.json?deploy=${COMMIT}`);
  assert.equal(host.calls[0].init.redirect, 'error');
  assert.equal(host.calls[0].init.cache, 'no-store');
});

test('polling fails on timeout with the last mismatch', async () => {
  const host = fakeHost([{ body: { app: 'hexframe', version: '1.3.9', commit: COMMIT } }]);
  const failures = await pollVersion({ label: 'hexframe', version: '1.4.0', commit: COMMIT, timeoutMs: 60_000, intervalMs: 10_000, ...host });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /did not report 1\.4\.0 .* before the timeout: version is "1\.3\.9"/);
  assert.equal(host.calls.length, 7);
});

test('the CLI exits 0 verified, 1 unverified and 2 on usage errors', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-verify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, 'deploy.ndjson');
  const current = join(dir, 'status.json');
  writeFileSync(output, `${deployLine()}\n`);
  writeFileSync(current, JSON.stringify(status([{ version_id: VERSION_ID, percentage: 100 }])));
  const io = () => ({ out: () => {}, err: () => {} });
  assert.equal(await run(['traffic', '--worker', 'hexframe', '--deploy-output', output, '--status', current], io()), 0);
  writeFileSync(current, JSON.stringify(status([{ version_id: VERSION_ID, percentage: 50 }])));
  assert.equal(await run(['traffic', '--worker', 'hexframe', '--deploy-output', output, '--status', current], io()), 1);
  assert.equal(await run(['traffic', '--worker', 'hexframe', '--deploy-output', join(dir, 'missing'), '--status', current], io()), 1);

  const live = fakeHost([{ body: { app: 'demo', version: '2.0.0', commit: COMMIT } }]);
  assert.equal(await run(['version', '--worker', 'demo', '--version', '2.0.0', '--commit', COMMIT], { ...io(), ...live }), 0);
  const stale = fakeHost([{ body: { app: 'demo', version: '1.9.0', commit: COMMIT } }]);
  assert.equal(await run(['version', '--worker', 'demo', '--version', '2.0.0', '--commit', COMMIT, '--timeout', '30', '--interval', '5'], { ...io(), ...stale }), 1);
  assert.equal(stale.calls.length, 7);

  for (const argv of [
    [], ['deploy', '--worker', 'demo'], ['host'], ['host', '--worker', 'staging'], ['host', '--worker', 'demo', '--status', 'x'],
    ['traffic', '--worker', 'demo', '--status', current], ['version', '--worker', 'demo', '--version', 'v2.0.0', '--commit', COMMIT],
    ['version', '--worker', 'demo', '--version', '2.0.0', '--commit', 'abc'], ['version', '--worker', 'demo', '--version', '2.0.0'],
    ['version', '--worker', 'demo', '--version', '2.0.0', '--commit', COMMIT, '--timeout', '0'], ['host', '--worker'],
    ['toString', '--worker', 'demo'], ['host', '--__proto__', 'x', '--worker', 'demo'],
  ]) {
    assert.equal(await run(argv, io()), 2, argv.join(' '));
  }
});

test('the vendored entry point runs as a script', () => {
  const result = spawnSync(process.execPath, [cli, 'host', '--worker', 'wizardgang'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'wizardgang.ai');
  assert.equal(spawnSync(process.execPath, [cli, 'host'], { encoding: 'utf8' }).status, 2);
});
