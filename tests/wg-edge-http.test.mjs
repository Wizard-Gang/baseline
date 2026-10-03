import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_ROBOTS, SECURITY_HEADERS, createEdge } from '../platform/wg-edge/index.mjs';

const release = { version: '1.2.3', commit: 'a'.repeat(40) };
const env = { WG_APP: 'wizardgang' };

function edge(options = {}) {
  const lines = [];
  const handler = createEdge({ release, logSink: (line) => lines.push(JSON.parse(line)), ...options });
  return { handler, lines };
}

const get = (url, headers = {}, init = {}) => new Request(url, { headers, ...init });

test('rejects a misconfigured release before serving anything', () => {
  assert.throws(() => createEdge({ release: { version: '1.2', commit: 'a'.repeat(40) } }), /semantic version/);
  assert.throws(() => createEdge({ release: { version: '1.2.3', commit: 'abc' } }), /40-character commit/);
});

test('host guard admits only the declared host and 308s www to the apex', async () => {
  const { handler, lines } = edge({ fetch: () => new Response('home') });
  const home = await handler.fetch(get('https://wizardgang.ai/'), env);
  assert.equal(await home.text(), 'home');

  const www = await handler.fetch(get('https://www.wizardgang.ai/work?x=1'), env);
  assert.equal(www.status, 308);
  assert.equal(www.headers.get('location'), 'https://wizardgang.ai/work?x=1');

  for (const host of ['demo.wizardgang.ai', 'wizardgang-portfolio.workers.dev', 'evil.example', 'wizardgang.ai.evil.example']) {
    const response = await handler.fetch(get(`https://${host}/`, { accept: 'application/json' }), env);
    assert.equal(response.status, 421, host);
    assert.equal((await response.json()).error, 'Misdirected request');
  }
  // www is only an alias for wizardgang; another Worker treats it as foreign.
  const sharktank = await handler.fetch(get('https://www.wizardgang.ai/'), { WG_APP: 'sharktank' });
  assert.equal(sharktank.status, 421);
  assert.ok(lines.some((line) => line.event === 'host_rejected' && line.host === 'evil.example'));
});

test('an undeclared or missing WG_APP fails closed with a redacted 500', async () => {
  const { handler, lines } = edge({ fetch: () => new Response('never') });
  for (const bad of [{}, { WG_APP: 'portfolio' }, { WG_APP: 'constructor' }, undefined]) {
    const response = await handler.fetch(get('https://wizardgang.ai/', { accept: 'application/json' }), bad);
    assert.equal(response.status, 500);
    assert.deepEqual(Object.keys(await response.json()).sort(), ['error', 'requestId', 'status']);
  }
  assert.ok(lines.every((line) => line.app === 'unconfigured'));
});

test('plain HTTP redirects reads and refuses writes and credentials', async () => {
  const { handler } = edge({ fetch: () => new Response('ok') });
  const plain = await handler.fetch(get('http://wizardgang.ai/a?b=1'), env);
  assert.equal(plain.status, 308);
  assert.equal(plain.headers.get('location'), 'https://wizardgang.ai/a?b=1');
  const visitor = await handler.fetch(get('https://wizardgang.ai/a', { 'cf-visitor': '{"scheme":"http"}' }), env);
  assert.equal(visitor.status, 308);
  const post = await handler.fetch(get('http://wizardgang.ai/a', {}, { method: 'POST', body: 'x' }), env);
  assert.equal(post.status, 403);
  const credential = await handler.fetch(get('http://wizardgang.ai/a', { authorization: 'Bearer x' }), env);
  assert.equal(credential.status, 403);
});

test('serves version, health and robots ahead of the app', async () => {
  let calls = 0;
  const { handler } = edge({ fetch: () => { calls += 1; return new Response('app'); } });
  const version = await handler.fetch(get('https://wizardgang.ai/version.json'), env);
  assert.deepEqual(await version.json(), { app: 'wizardgang', version: '1.2.3', commit: 'a'.repeat(40) });
  assert.equal(version.headers.get('cache-control'), 'no-store');
  const health = await handler.fetch(get('https://wizardgang.ai/health.json'), env);
  assert.deepEqual(await health.json(), { status: 'ok', app: 'wizardgang', version: '1.2.3' });
  const robots = await handler.fetch(get('https://wizardgang.ai/robots.txt'), env);
  assert.equal(await robots.text(), DEFAULT_ROBOTS);
  assert.match(robots.headers.get('content-type'), /^text\/plain/);
  const post = await handler.fetch(get('https://wizardgang.ai/version.json', {}, { method: 'POST' }), env);
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  assert.equal(calls, 0);
});

test('health reports degraded without detail when the app check fails', async () => {
  for (const health of [() => false, () => { throw new Error('db password=hunter2'); }]) {
    const { handler, lines } = edge({ health });
    const response = await handler.fetch(get('https://wizardgang.ai/health.json'), env);
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { status: 'degraded', app: 'wizardgang', version: '1.2.3' });
    assert.doesNotMatch(body, /hunter2/);
    assert.ok(lines.every((line) => !JSON.stringify(line).includes('stack')));
  }
  const { handler } = edge({ robots: 'User-agent: *\nDisallow: /\n' });
  assert.equal(await (await handler.fetch(get('https://wizardgang.ai/robots.txt'), env)).text(), 'User-agent: *\nDisallow: /\n');
});

test('404s are JSON for API clients and HTML for browsers', async () => {
  const { handler } = edge({ fetch: () => null });
  const api = await handler.fetch(get('https://wizardgang.ai/missing', { accept: 'application/json', 'cf-ray': 'ray-1' }), env);
  assert.equal(api.status, 404);
  assert.match(api.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await api.json(), { error: 'Not found', status: 404, requestId: 'ray-1' });
  const any = await handler.fetch(get('https://wizardgang.ai/missing'), env);
  assert.match(any.headers.get('content-type'), /^application\/json/);

  const browser = await handler.fetch(get('https://wizardgang.ai/missing', { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }), env);
  assert.equal(browser.status, 404);
  assert.match(browser.headers.get('content-type'), /^text\/html/);
  const html = await browser.text();
  assert.match(html, /<h1>404 Not found<\/h1>/);
  assert.equal(browser.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");

  const shellOnly = createEdge({ release, logSink() {} });
  assert.equal((await shellOnly.fetch(get('https://wizardgang.ai/anything'), env)).status, 404);
});

test('security headers cover shell and app responses without overriding app choices', async () => {
  const { handler } = edge({ fetch: () => new Response('app', { headers: { 'x-frame-options': 'SAMEORIGIN' } }) });
  const app = await handler.fetch(get('https://wizardgang.ai/'), env);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(app.headers.get(name), name === 'x-frame-options' ? 'SAMEORIGIN' : value, name);
  }
  const shell = await handler.fetch(get('https://wizardgang.ai/version.json'), env);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(shell.headers.get(name), value, name);
  // Frozen Response headers (as from fetch()) are rebuilt, not mutated in place.
  const frozen = Response.redirect('https://wizardgang.ai/next', 302);
  const passthrough = edge({ fetch: () => frozen }).handler;
  assert.equal((await passthrough.fetch(get('https://wizardgang.ai/'), env)).headers.get('x-content-type-options'), 'nosniff');
});

test('the error boundary never returns messages or stacks', async () => {
  const secret = 'token=s3cr3t-value';
  for (const fetch of [() => { throw new Error(secret); }, async () => { throw new TypeError(secret); }, () => 'not a response']) {
    const { handler, lines } = edge({ fetch });
    for (const accept of ['application/json', 'text/html']) {
      const response = await handler.fetch(get('https://wizardgang.ai/boom', { accept }), env);
      assert.equal(response.status, 500);
      const body = await response.text();
      assert.doesNotMatch(body, /s3cr3t|at .*\.mjs|Error:|stack/i);
      assert.match(body, /Internal error/);
    }
    const unhandled = lines.find((line) => line.event === 'unhandled');
    assert.ok(unhandled);
    assert.equal(unhandled.error.stack, undefined);
    assert.deepEqual(Object.keys(unhandled.error).sort(), ['message', 'name']);
  }
});

test('structured logs carry one JSON line per request without query strings or headers', async () => {
  const { handler, lines } = edge({ fetch: () => new Response('ok', { status: 201 }) });
  await handler.fetch(get('https://wizardgang.ai/path?token=abc', { authorization: 'Bearer abc', cookie: 'sid=abc', 'cf-ray': 'ray-9' }), env);
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.equal(line.event, 'request');
  assert.equal(line.level, 'info');
  assert.equal(line.app, 'wizardgang');
  assert.equal(line.requestId, 'ray-9');
  assert.equal(line.path, '/path');
  assert.equal(line.status, 201);
  assert.equal(typeof line.ms, 'number');
  assert.match(line.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(JSON.stringify(line), /abc/);
  await handler.fetch(get('https://wizardgang.ai/', { 'cf-ray': 'r'.repeat(500) }), env);
  assert.equal(lines.at(-1).requestId.length, 64);
});

test('WebSocket upgrades pass through untouched', async () => {
  const upgrade = new Response(null, { status: 200 });
  Object.defineProperty(upgrade, 'status', { value: 101 });
  const { handler } = edge({ fetch: () => upgrade });
  assert.equal(await handler.fetch(get('https://wizardgang.ai/ws'), env), upgrade);
});

test('the scheduled wrapper logs, scopes to WG_APP and redacts failures', async () => {
  const seen = [];
  const { handler, lines } = edge({ scheduled: (controller, _env, _ctx, edgeContext) => { seen.push(edgeContext.app, controller.cron); } });
  await handler.scheduled({ cron: '*/5 * * * *' }, { WG_APP: 'demo' });
  assert.deepEqual(seen, ['demo', '*/5 * * * *']);
  assert.equal(lines.at(-1).event, 'scheduled');

  const failing = edge({ scheduled: () => { throw new Error('secret detail'); } });
  await assert.rejects(failing.handler.scheduled({ cron: 'x' }, { WG_APP: 'demo' }), (error) => error.message === 'scheduled handler failed');
  assert.equal(failing.lines.at(-1).event, 'scheduled_failed');
  await assert.rejects(failing.handler.scheduled({}, { WG_APP: 'nope' }), /scheduled handler failed/);
});
