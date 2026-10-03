import assert from 'node:assert/strict';
import test from 'node:test';
import { constantTimeEqual, createEdge, readSecret, sessionKey } from '../platform/wg-edge/index.mjs';

const release = { version: '1.0.0', commit: 'b'.repeat(40) };
const TOKEN = 'ops-token-for-tests-only';
const basic = (user, pass) => `Basic ${btoa(`${user}:${pass}`)}`;

function edge() {
  const lines = [];
  const reached = [];
  const handler = createEdge({
    release,
    logSink: (line) => lines.push(JSON.parse(line)),
    fetch: (request, _env, _ctx, edgeContext) => {
      reached.push({ path: edgeContext.url.pathname, admin: edgeContext.admin });
      return new Response('admin page');
    },
  });
  return { handler, lines, reached };
}

const admin = (headers = {}, url = 'https://sharktank.wizardgang.ai/admin/rooms') => new Request(url, { headers: { accept: 'application/json', ...headers } });

test('admin is denied with 503 and no credential prompt when WG_OPS_TOKEN is unset', async () => {
  for (const env of [{ WG_APP: 'sharktank' }, { WG_APP: 'sharktank', WG_OPS_TOKEN: '' },
    { WG_APP: 'sharktank', WG_OPS_TOKEN: { get: async () => '' } },
    { WG_APP: 'sharktank', WG_OPS_TOKEN: { get: async () => { throw new Error('store down'); } } }]) {
    const { handler, reached, lines } = edge();
    // Even a credential that would match an empty token must not get through.
    for (const authorization of [undefined, 'Bearer ', basic('ops', '')]) {
      const response = await handler.fetch(admin(authorization ? { authorization } : {}), env);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('www-authenticate'), null);
    }
    assert.deepEqual(reached, []);
    assert.ok(lines.some((line) => line.event === 'admin_denied' && line.reason === 'unconfigured'));
  }
});

test('admin refuses plain HTTP even with the right credential', async () => {
  const env = { WG_APP: 'sharktank', WG_OPS_TOKEN: TOKEN };
  const { handler, reached } = edge();
  for (const request of [
    admin({ authorization: `Bearer ${TOKEN}` }, 'http://sharktank.wizardgang.ai/admin/rooms'),
    admin({ authorization: `Bearer ${TOKEN}`, 'cf-visitor': '{"scheme":"http"}' }),
    admin({ authorization: basic('ops', TOKEN), 'x-forwarded-proto': 'http' }),
    admin({ authorization: `Bearer ${TOKEN}`, 'cf-visitor': 'not json' }),
    admin({}, 'http://sharktank.wizardgang.ai/admin'),
  ]) {
    const response = await handler.fetch(request, env);
    assert.equal(response.status, 403, request.url);
    assert.equal(response.headers.get('location'), null);
  }
  assert.deepEqual(reached, []);
});

test('admin denies a missing, wrong-scheme or wrong credential with a 401 prompt', async () => {
  const env = { WG_APP: 'sharktank', WG_OPS_TOKEN: TOKEN };
  const { handler, reached } = edge();
  for (const authorization of [undefined, `bearer ${TOKEN}`, `Token ${TOKEN}`, `Digest ${TOKEN}`, `Bearer ${TOKEN}x`,
    `Bearer ${TOKEN.slice(0, -1)}`, `Bearer  ${TOKEN}`, basic('admin', TOKEN), basic('ops', 'wrong'), `Basic ${btoa(TOKEN)}`,
    'Basic %%%not-base64', basic('ops', `${TOKEN}:extra`)]) {
    const response = await handler.fetch(admin(authorization ? { authorization } : {}), env);
    assert.equal(response.status, 401, String(authorization));
    assert.equal(response.headers.get('www-authenticate'), 'Basic realm="WizardGang Ops", charset="UTF-8"');
    const body = await response.text();
    assert.doesNotMatch(body, new RegExp(TOKEN));
  }
  assert.deepEqual(reached, []);
});

test('admin admits the exact Bearer token or ops Basic pair over TLS, from a secret or the Secrets Store', async () => {
  for (const binding of [TOKEN, { get: async () => TOKEN }]) {
    const env = { WG_APP: 'sharktank', WG_OPS_TOKEN: binding };
    const { handler, reached } = edge();
    for (const authorization of [`Bearer ${TOKEN}`, basic('ops', TOKEN)]) {
      const response = await handler.fetch(admin({ authorization, 'cf-visitor': '{"scheme":"https"}' }), env);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'admin page');
    }
    assert.deepEqual(reached, [{ path: '/admin/rooms', admin: true }, { path: '/admin/rooms', admin: true }]);
  }
});

test('the gate covers /admin and /admin/* only', async () => {
  const env = { WG_APP: 'sharktank', WG_OPS_TOKEN: TOKEN };
  const { handler, reached } = edge();
  assert.equal((await handler.fetch(admin({}, 'https://sharktank.wizardgang.ai/admin'), env)).status, 401);
  assert.equal((await handler.fetch(admin({}, 'https://sharktank.wizardgang.ai/admin/'), env)).status, 401);
  assert.equal((await handler.fetch(admin({}, 'https://sharktank.wizardgang.ai/ADMIN/../admin/x'), env)).status, 401);
  for (const variant of ['/Admin/x', '/ADMIN', '/%61dmin/x', '/%41DMIN']) {
    assert.equal((await handler.fetch(admin({}, `https://sharktank.wizardgang.ai${variant}`), env)).status, 401, variant);
  }
  assert.equal((await handler.fetch(admin({}, 'https://sharktank.wizardgang.ai/administrator'), env)).status, 200);
  assert.deepEqual(reached, [{ path: '/administrator', admin: false }]);
});

test('constant-time comparison and secret resolution', async () => {
  assert.equal(await constantTimeEqual('same', 'same'), true);
  assert.equal(await constantTimeEqual('same', 'Same'), false);
  assert.equal(await constantTimeEqual('short', 'a much longer value'), false);
  assert.equal(await constantTimeEqual('', ''), true);
  assert.equal(await readSecret('plain'), 'plain');
  assert.equal(await readSecret({ get: async () => 'stored' }), 'stored');
  for (const missing of [undefined, null, 42, {}, { get: async () => 7 }, { get: () => { throw new Error('x'); } }]) {
    assert.equal(await readSecret(missing), '');
  }
  assert.equal(await sessionKey({ WG_SESSION_KEY: { get: async () => 'session' } }), 'session');
  assert.equal(await sessionKey({}), '');
});
