import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DESIRED } from '../platform/conformance/desired.mjs';
import {
  buildResult, checkHealth, checkIdentity, checkTraffic, hostFor, observe, pageAssets, pollVersion, run, validateResult, verifyAssets, verifyHealth,
} from '../platform/deploy/verify.mjs';

const COMMIT = 'a'.repeat(40);
const VERSION_ID = '0b5ef3c1-6f0e-4d4e-9a35-2d1c3f9e8a11';
const deployLine = (fields = {}) => JSON.stringify({ type: 'deploy', version: 1, worker_name: 'hexframe', version_id: VERSION_ID, ...fields });
const status = (versions) => ({ id: 'deployment', versions });
const cli = fileURLToPath(new URL('../platform/deploy/verify.mjs', import.meta.url));

const respond = (next) => ({
  status: next.status ?? 200,
  headers: new Headers(next.headers ?? {}),
  text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
});

/** A fake public host: each call returns the next scripted response, repeating the last one. */
function fakeHost(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return respond(next);
  };
  let clock = 0;
  return { calls, fetch, now: () => clock, sleep: async (ms) => { clock += ms; }, log: () => {} };
}

/** A fake public site keyed by path; a missing path is a 404. */
function fakeSite(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const { pathname, origin } = new URL(url);
    const next = Object.hasOwn(routes, pathname) ? routes[pathname] : { status: 404, body: 'missing' };
    if (next instanceof Error) throw next;
    return respond(typeof next === 'function' ? next(origin) : next);
  };
  let clock = Date.parse('2026-10-09T18:00:00.000Z');
  return { calls, fetch, now: () => clock, sleep: async (ms) => { clock += ms; }, log: () => {} };
}

const HTML = { 'content-type': 'text/html; charset=utf-8' };
const PAGE = '<!doctype html><link rel="canonical" href="https://demo.wizardgang.ai/"><link rel="stylesheet" href="/assets/shell-bMbz_FQ0.css">'
  + '<script type="module" src="/assets/shell-browser-C3W1tXrY.js"></script><link rel="modulepreload" href="/assets/chunk.js">'
  + '<script src="https://cdn.example.com/x.js"></script><link rel="icon" href="data:image/svg+xml,x"><script>inline()</script>';
const demoSite = (overrides = {}) => fakeSite({
  '/version.json': { body: { app: 'demo', version: '2.0.0', commit: COMMIT } },
  '/health.json': { body: { status: 'ok', app: 'demo', version: '2.0.0' } },
  '/': { headers: HTML, body: PAGE },
  '/assets/shell-bMbz_FQ0.css': { headers: { 'content-type': 'text/css' }, body: 'body{}' },
  '/assets/shell-browser-C3W1tXrY.js': { headers: { 'content-type': 'application/javascript' }, body: 'export {}' },
  '/assets/chunk.js': { headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: 'export {}' },
  ...overrides,
});
const ENV = { GITHUB_REPOSITORY: 'Wizard-Gang/wizardgang-architecture-demo', GITHUB_RUN_ID: '37790745852', GITHUB_RUN_ATTEMPT: '1', CLOUDFLARE_ACCOUNT_ID: '0aa5' };
const demoDeploy = `${JSON.stringify({ type: 'deploy', version: 1, worker_name: 'demo', version_id: VERSION_ID })}\n`;
const demoStatus = status([{ version_id: VERSION_ID, percentage: 100 }]);

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

test('a Cloudflare challenge is reported apart from a timeout, and nothing redeploys', async () => {
  const host = fakeHost([{ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: '<html>challenge</html>' }]);
  const failures = await pollVersion({ label: 'hexframe', version: '1.4.0', commit: COMMIT, timeoutMs: 30_000, intervalMs: 10_000, ...host });
  assert.match(failures.join(), /stayed behind a Cloudflare challenge until the timeout: Cloudflare challenged the runner \(HTTP 403\)/);
  assert.ok(host.calls.every(({ url }) => url.endsWith('/version.json?deploy=' + COMMIT)));
});

test('polling fails on timeout with the last mismatch', async () => {
  const host = fakeHost([{ body: { app: 'hexframe', version: '1.3.9', commit: COMMIT } }]);
  const failures = await pollVersion({ label: 'hexframe', version: '1.4.0', commit: COMMIT, timeoutMs: 60_000, intervalMs: 10_000, ...host });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /did not report 1\.4\.0 .* before the timeout: version is "1\.3\.9"/);
  assert.equal(host.calls.length, 7);
});

test('health must report ok with the deployed label and version', async () => {
  assert.deepEqual(checkHealth({ status: 'ok', app: 'demo', version: '2.0.0', extra: 1 }, { label: 'demo', version: '2.0.0' }), []);
  assert.equal(checkHealth({ status: 'degraded', app: 'demo', version: '2.0.0' }, { label: 'demo', version: '2.0.0' }).length, 1);
  assert.equal(checkHealth(null, { label: 'demo', version: '2.0.0' }).length, 3);
  assert.deepEqual(await verifyHealth({ label: 'demo', version: '2.0.0', commit: COMMIT, fetch: demoSite().fetch }), []);
  for (const [route, pattern] of [
    [{ status: 503, body: { status: 'degraded', app: 'demo', version: '2.0.0' } }, /HTTP 503/],
    [{ body: { status: 'ok', app: 'demo', version: '1.9.0' } }, /health version is "1\.9\.0"/],
    [{ body: 'not json' }, /not JSON/],
    [{ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: '' }, /Cloudflare challenged the runner/],
    [new Error('fetch failed'), /fetch failed/],
  ]) {
    assert.match((await verifyHealth({ label: 'demo', version: '2.0.0', commit: COMMIT, fetch: demoSite({ '/health.json': route }).fetch })).join(), pattern);
  }
});

test('the root page names its same-origin scripts and stylesheets, and each loads with a matching type', async () => {
  assert.deepEqual(pageAssets(PAGE, 'https://demo.wizardgang.ai/').map(({ url, kind }) => `${kind} ${url}`), [
    'style https://demo.wizardgang.ai/assets/shell-bMbz_FQ0.css',
    'script https://demo.wizardgang.ai/assets/shell-browser-C3W1tXrY.js',
    'script https://demo.wizardgang.ai/assets/chunk.js',
  ]);
  assert.deepEqual(await verifyAssets({ label: 'demo', fetch: demoSite().fetch }), { failures: [], assets: 3 });
  // Hexframe and SharkTank answer / with a 308 to /play/.
  const play = fakeSite({
    '/': { status: 308, headers: { location: 'https://hexframe.wizardgang.ai/play/' }, body: '' },
    '/play/': { headers: HTML, body: '<script type="module" src="./main.js"></script>' },
    '/play/main.js': { headers: { 'content-type': 'text/javascript' }, body: 'x' },
  });
  assert.deepEqual(await verifyAssets({ label: 'hexframe', fetch: play.fetch }), { failures: [], assets: 1 });
  assert.equal(play.calls[0].init.redirect, 'manual');
  const failing = [
    [{ '/assets/shell-bMbz_FQ0.css': { status: 404, body: 'missing' } }, /shell-bMbz_FQ0\.css: HTTP 404/],
    [{ '/assets/chunk.js': { headers: HTML, body: '<html>' } }, /chunk\.js: HTTP 200 text\/html.*expected a non-empty script/],
    [{ '/assets/shell-browser-C3W1tXrY.js': { headers: { 'content-type': 'application/javascript' }, body: '' } }, /expected a non-empty script/],
    [{ '/': { status: 500, headers: HTML, body: 'oops' } }, /HTTP 500.*expected HTML/],
    [{ '/': { headers: { 'content-type': 'application/json' }, body: '{}' } }, /expected HTML/],
    [{ '/': { status: 302, headers: { location: 'https://evil.example/' }, body: '' } }, /leaves https:\/\/demo\.wizardgang\.ai/],
    [{ '/': { status: 302, headers: { location: '/' }, body: '' } }, /redirects more than 3 times/],
    [{ '/': { headers: HTML, body: Array.from({ length: 21 }, (_, index) => `<script src="/a${index}.js"></script>`).join('') } }, /names 21 .* at most 20/],
  ];
  for (const [routes, pattern] of failing) {
    assert.match((await verifyAssets({ label: 'demo', fetch: demoSite(routes).fetch })).failures.join('\n'), pattern, JSON.stringify(routes));
  }
});

test('the result carries only whitelisted, safely shaped fields', () => {
  const built = buildResult({ label: 'demo', tag: 'v2.0.0', commit: COMMIT, env: ENV, deploy: { version_id: VERSION_ID, account_id: '0aa5' }, assets: 3, observedAt: '2026-10-09T18:00:00.000Z' });
  assert.deepEqual(built.failures, []);
  assert.deepEqual(built.result, {
    schema: 1, worker: 'demo', host: 'demo.wizardgang.ai', repository: 'Wizard-Gang/wizardgang-architecture-demo', run_id: 37790745852, run_attempt: 1,
    tag: 'v2.0.0', commit: COMMIT, observed_at: '2026-10-09T18:00:00.000Z', worker_version_id: VERSION_ID, traffic_percentage: 100, assets_checked: 3,
    checks: { reproduction: 'passed', traffic: 'passed', version: 'passed', health: 'passed', assets: 'passed' },
  });
  assert.ok(!JSON.stringify(built.result).includes('0aa5'));
  const ok = built.result;
  const failing = [
    [{ ...ok, account_id: '0aa5' }, /must not carry "account_id"/],
    [{ ...ok, wrangler: { raw: true } }, /must not carry "wrangler"/],
    [{ ...ok, worker_version_id: 'Bearer abc' }, /worker_version_id is missing or unsafe/],
    [{ ...ok, repository: 'x/y z' }, /repository is missing or unsafe/],
    [{ ...ok, run_id: '1' }, /run_id is missing or unsafe/],
    [{ ...ok, traffic_percentage: 50 }, /traffic_percentage/],
    [{ ...ok, checks: { ...ok.checks, health: 'skipped' } }, /checks is missing or unsafe/],
    [{ ...ok, checks: { ...ok.checks, extra: 'passed' } }, /checks is missing or unsafe/],
    [{ ...ok, host: 'hexframe.wizardgang.ai' }, /host does not belong to its worker/],
    [{ ...ok, observed_at: 'yesterday' }, /observed_at/],
  ];
  for (const [result, pattern] of failing) assert.match(validateResult(result).join('\n'), pattern);
  assert.match(buildResult({ label: 'demo', tag: 'v2.0.0', commit: COMMIT, env: { ...ENV, GITHUB_RUN_ID: 'x' }, deploy: { version_id: VERSION_ID }, assets: 0, observedAt: ok.observed_at }).failures.join(), /run_id/);
});

test('observing production yields a result only after traffic, identity, health and assets all pass', async () => {
  const input = { label: 'demo', tag: 'v2.0.0', commit: COMMIT, deployOutput: demoDeploy, status: demoStatus, env: ENV, timeoutMs: 30_000, intervalMs: 10_000 };
  const passed = await observe({ ...input, ...demoSite() });
  assert.deepEqual(passed.failures, []);
  assert.equal(passed.result.worker_version_id, VERSION_ID);
  assert.equal(passed.result.observed_at, '2026-10-09T18:00:00.000Z');
  const failing = [
    [{ status: status([{ version_id: VERSION_ID, percentage: 50 }]) }, {}, /50% of traffic/],
    [{}, { '/version.json': { body: { app: 'demo', version: '1.9.0', commit: COMMIT } } }, /before the timeout/],
    [{}, { '/health.json': { status: 503, body: {} } }, /HTTP 503/],
    [{}, { '/assets/chunk.js': { status: 404, body: '' } }, /chunk\.js: HTTP 404/],
    [{ env: { ...ENV, GITHUB_RUN_ATTEMPT: undefined } }, {}, /run_attempt is missing or unsafe/],
  ];
  for (const [change, routes, pattern] of failing) {
    const outcome = await observe({ ...input, ...change, ...demoSite(routes) });
    assert.match(outcome.failures.join('\n'), pattern);
    assert.equal(outcome.result, undefined);
  }
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

  const demoOutput = join(dir, 'demo.ndjson');
  const result = join(dir, 'result.json');
  writeFileSync(demoOutput, demoDeploy);
  writeFileSync(current, JSON.stringify(demoStatus));
  const observeArgs = ['observe', '--worker', 'demo', '--tag', 'v2.0.0', '--commit', COMMIT, '--deploy-output', demoOutput, '--status', current, '--result', result];
  assert.equal(await run(observeArgs, { ...io(), env: ENV, ...demoSite() }), 0);
  assert.deepEqual(validateResult(JSON.parse(readFileSync(result, 'utf8'))), []);
  rmSync(result);
  const stale = demoSite({ '/version.json': { body: { app: 'demo', version: '1.9.0', commit: COMMIT } } });
  assert.equal(await run([...observeArgs, '--timeout', '30', '--interval', '5'], { ...io(), env: ENV, ...stale }), 1);
  assert.equal(stale.calls.length, 7);
  assert.throws(() => readFileSync(result), /ENOENT/);
  // Evidence with no run identity fails closed instead of falling back to anything.
  assert.equal(await run(['evidence', '--worker', 'demo', '--tag', 'v2.0.0', '--commit', COMMIT], { ...io(), env: {} }), 1);

  for (const argv of [
    [], ['deploy', '--worker', 'demo'], ['host'], ['host', '--worker', 'staging'], ['host', '--worker', 'demo', '--status', 'x'],
    ['traffic', '--worker', 'demo', '--status', current], ['version', '--worker', 'demo', '--version', '2.0.0', '--commit', COMMIT],
    ['evidence', '--worker', 'demo', '--tag', '2.0.0', '--commit', COMMIT], ['evidence', '--worker', 'demo', '--tag', 'v2.0.0', '--commit', 'abc'],
    ['evidence', '--worker', 'demo', '--tag', 'v2.0.0'], [...observeArgs.slice(0, -2)], [...observeArgs, '--timeout', '0'],
    ['observe', '--worker', 'demo', '--tag', 'v2.0.0', '--commit', COMMIT, '--deploy-output', demoOutput, '--status', current, '--result', result, '--version', '2.0.0'],
    ['host', '--worker'],
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
