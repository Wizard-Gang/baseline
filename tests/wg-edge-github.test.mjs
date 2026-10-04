import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DESIRED } from '../platform/conformance/desired.mjs';
import { GITHUB_APP, GitHubAppError, createEdge, githubAppToken } from '../platform/wg-edge/index.mjs';
import { fakeGitHub, rsaKeys } from './fixtures/wg-edge-fakes.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const registry = read('../config/secrets.json');
const cloudflare = read('../config/cloudflare.json');
// Generated per run; the App and installation IDs are placeholders, not real ones.
const keys = rsaKeys();
const APP_ID = '1000001';
const INSTALLATION = 2000002;
const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);
const env = (overrides = {}) => ({ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: keys.pkcs8, ...overrides });
const request = (permissions = { contents: 'read' }) => ({ installationId: INSTALLATION, permissions });
const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const pemBody = (pem) => pem.split('\n').filter((line) => line && !line.startsWith('-----')).join('');

function harness(options = {}) {
  let now = T0;
  const github = fakeGitHub({ now: () => now, ...options });
  const cache = new Map();
  return {
    github,
    cache,
    advance(ms) { now += ms; },
    // An explicit undefined request is passed through; only an omitted one defaults.
    token: (e = env(), ...rest) => githubAppToken(e, rest.length ? rest[0] : request(), { fetch: github.fetch, now: () => now, cache }),
  };
}

function assertNoLeak(error, secrets) {
  const surface = JSON.stringify({ message: error.message, stack: error.stack, own: Object.getOwnPropertyNames(error).map((key) => String(error[key])) });
  for (const secret of secrets.filter(Boolean)) {
    for (const piece of [secret, secret.slice(0, 40), secret.slice(-40)]) assert.ok(!surface.includes(piece), 'the error leaks secret material');
  }
  assert.equal(error.cause, undefined);
}

async function failsClosed(promise, message, secrets = []) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof GitHubAppError, `expected GitHubAppError, got ${error?.name}: ${error?.message}`);
    assert.match(error.message, message);
    assertNoLeak(error, [pemBody(keys.pkcs8), pemBody(keys.pkcs1), ...secrets]);
    return true;
  });
}

test('the App binding names mirror the registry wg-github-app entries and the Worker secret list', () => {
  const worker = registry.entries.filter((entry) => entry.home === 'worker' && entry.provider === 'github');
  const key = worker.find((entry) => entry.credential === GITHUB_APP.credential);
  const id = worker.find((entry) => entry.kind === 'variable' && entry.name === GITHUB_APP.id);
  assert.deepEqual([key?.name, key?.kind], [GITHUB_APP.privateKey, 'secret']);
  assert.deepEqual(key.consumers, [...GITHUB_APP.consumers]);
  assert.deepEqual(id?.consumers, [...GITHUB_APP.consumers]);
  for (const label of GITHUB_APP.consumers) {
    assert.ok(cloudflare.workers[label].secrets.includes(GITHUB_APP.privateKey));
    assert.ok(DESIRED.workers[label].secrets.includes(GITHUB_APP.privateKey));
  }
  assert.ok(Object.isFrozen(GITHUB_APP) && Object.isFrozen(GITHUB_APP.consumers));
});

test('a PKCS#8 RSA key fits a Secrets Store value, yet the registry keeps it a Worker secret', () => {
  // Cloudflare limits, read 2026-10-04: a Secrets Store value is at most 65,536 bytes; a Worker secret at most 5 KB.
  const SECRETS_STORE_VALUE_BYTES = 65_536;
  const WORKER_SECRET_BYTES = 5 * 1024;
  for (const pem of [keys.pkcs8, rsaKeys(4096).pkcs8]) {
    const bytes = Buffer.byteLength(pem);
    assert.ok(bytes <= SECRETS_STORE_VALUE_BYTES && bytes <= WORKER_SECRET_BYTES, `${bytes} bytes`);
  }
  // The Secrets Store holds only shared WG_ platform secrets, and only the demo signs App tokens.
  assert.ok(registry.entries.filter((entry) => entry.name === GITHUB_APP.privateKey).every((entry) => entry.home !== 'secrets-store'));
  assert.ok(!cloudflare.secretsStore.flatMap((store) => store.secrets).includes(GITHUB_APP.privateKey));
});

test('the app JWT carries backdated iat, exp within 10 minutes and the App ID, and verifies against the public key', async () => {
  const { github, token } = harness();
  assert.match(await token(), /^ghs_/);
  const [call] = github.calls;
  assert.equal(call.url, `https://api.github.com/app/installations/${INSTALLATION}/access_tokens`);
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.accept, 'application/vnd.github+json');
  assert.equal(call.headers['x-github-api-version'], '2022-11-28');
  assert.ok(call.headers['user-agent']);
  assert.deepEqual(call.body, { permissions: { contents: 'read' } });
  const [header, payload, signature] = call.jwt.split('.');
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' });
  const claims = decode(payload);
  const now = T0 / 1000;
  assert.deepEqual(Object.keys(claims).sort(), ['exp', 'iat', 'iss']);
  assert.equal(claims.iss, APP_ID);
  assert.ok(claims.iat < now && claims.iat >= now - 60);
  assert.ok(claims.exp > now && claims.exp - now <= 600 && claims.exp - claims.iat <= 600);
  assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, 'base64url')));
  assert.ok(!verify('sha256', Buffer.from(`${header}.${payload}`), rsaKeys().publicKey, Buffer.from(signature, 'base64url')));
});

test('a key pasted with literal \\n escapes, or a Secrets Store binding, signs the same way', async () => {
  for (const privateKey of [keys.pkcs8.replace(/\n/g, '\\n'), { async get() { return keys.pkcs8; } }]) {
    const { github, token } = harness();
    await token(env({ GITHUB_APP_PRIVATE_KEY: privateKey }));
    const [header, payload, signature] = github.calls[0].jwt.split('.');
    assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, 'base64url')));
  }
});

test('tokens are cached per installation and permission set, and concurrent callers share one exchange', async () => {
  const { github, token } = harness();
  const [a, b] = await Promise.all([token(), token()]);
  assert.equal(a, b);
  assert.equal(github.calls.length, 1);
  assert.equal(await token(), a);
  const both = request({ metadata: 'read', contents: 'write' });
  const c = await token(env(), both);
  assert.equal(await token(env(), request({ contents: 'write', metadata: 'read' })), c);
  assert.deepEqual(Object.keys(github.calls[1].body.permissions), ['contents', 'metadata']);
  await token(env(), { installationId: String(INSTALLATION + 1), permissions: { contents: 'read' } });
  assert.equal(github.calls.length, 3);
});

test('a cached token is refreshed once less than five minutes of its life remain', async () => {
  const { github, token, advance } = harness();
  const first = await token();
  advance(54 * 60_000); // six minutes left
  assert.equal(await token(), first);
  advance(60_000 + 1); // just under five minutes left
  const second = await token();
  assert.notEqual(second, first);
  assert.equal(github.calls.length, 2);
  assert.equal(await token(), second);
});

test('a missing or malformed private key fails closed before any request, without leaking it', async () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const truncated = keys.pkcs8.split('\n').filter((line, index) => index < 2 || index > 6).join('\n'); // five whole base64 lines gone
  assert.ok(truncated.length < keys.pkcs8.length - 300);
  const cases = [
    [undefined, /^GITHUB_APP_PRIVATE_KEY is not configured$/],
    ['', /^GITHUB_APP_PRIVATE_KEY is not configured$/],
    [{ async get() { throw new Error(keys.pkcs8); } }, /^GITHUB_APP_PRIVATE_KEY is not configured$/],
    [keys.pkcs1, /must be PKCS#8/],
    [pemBody(keys.pkcs8), /not a PKCS#8 RSA private key/],
    [truncated, /not a PKCS#8 RSA private key/],
    [keys.pkcs8.replace('PRIVATE KEY-----\n', 'PRIVATE KEY-----\n!'), /not a PKCS#8 RSA private key/],
    [ec, /not a PKCS#8 RSA private key/],
    [weak, /at least 2048 bits/],
  ];
  for (const [privateKey, message] of cases) {
    const { github, token } = harness();
    await failsClosed(token(env({ GITHUB_APP_PRIVATE_KEY: privateKey })), message, [pemBody(ec), pemBody(weak)]);
    assert.equal(github.calls.length, 0);
  }
});

test('a malformed App ID, installation or permission set fails closed before any request', async () => {
  const cases = [
    [env({ GITHUB_APP_ID: undefined }), request(), /GITHUB_APP_ID must be the numeric App ID/],
    [env({ GITHUB_APP_ID: 'Iv1.abc' }), request(), /GITHUB_APP_ID/],
    [env(), { installationId: 0, permissions: { contents: 'read' } }, /installationId/],
    [env(), { installationId: '12/../1', permissions: { contents: 'read' } }, /installationId/],
    [env(), { installationId: INSTALLATION }, /at least one permission/],
    [env(), request({}), /at least one permission/],
    [env(), request({ contents: 'owner' }), /read, write or admin/],
    [env(), request({ 'Contents ': 'read' }), /lower-case name/],
    [env(), undefined, /installationId/],
  ];
  for (const [e, r, message] of cases) {
    const { github, token } = harness();
    await failsClosed(token(e, r), message);
    assert.equal(github.calls.length, 0);
  }
});

test('a denied exchange or an unexpected response fails closed, is not cached and leaks no JWT or token', async () => {
  const leaked = 'ghs_LEAKEDLEAKEDLEAKEDLEAKEDLEAKED0000';
  const reply = (status, body) => () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  const later = new Date(T0 + 3_600_000).toISOString();
  const cases = [
    [() => { throw new Error('network down'); }, /could not reach GitHub/],
    [reply(401, { message: 'A JSON web token could not be decoded', token: leaked }), /refused \(HTTP 401\)/],
    [reply(403, { message: 'forbidden', token: leaked }), /refused \(HTTP 403\)/],
    [reply(404, { message: 'Not Found' }), /refused \(HTTP 404\)/],
    [reply(422, { message: 'permissions not granted', token: leaked }), /refused \(HTTP 422\)/],
    [reply(200, { token: leaked, expires_at: later, permissions: { contents: 'read' } }), /refused \(HTTP 200\)/],
    [reply(201, `{"token":"${leaked}"`), /unexpected response/],
    [reply(201, { token: '', expires_at: later, permissions: { contents: 'read' } }), /unexpected response/],
    [reply(201, { token: `${leaked} x`, expires_at: later, permissions: { contents: 'read' } }), /unexpected response/],
    [reply(201, { token: leaked, expires_at: 'soon', permissions: { contents: 'read' } }), /unexpected response/],
    [reply(201, { token: leaked, expires_at: new Date(T0 - 1).toISOString(), permissions: { contents: 'read' } }), /unexpected response/],
    [reply(201, { token: leaked, expires_at: later, permissions: { metadata: 'read' } }), /lacks a requested permission/],
    [reply(201, { token: leaked, expires_at: later }), /lacks a requested permission/],
  ];
  for (const [respond, message] of cases) {
    const { github, token, cache } = harness({ respond });
    await failsClosed(token(), message, [leaked]);
    const jwt = github.calls[0]?.jwt;
    await assert.rejects(token(), (error) => { assertNoLeak(error, [jwt, leaked]); return true; });
    assert.equal(github.calls.length, 2, 'a failed exchange is never cached');
    assert.equal(cache.size, 0);
  }
  const { token } = harness({ respond: reply(201, { token: leaked, expires_at: later, permissions: { contents: 'write' } }) });
  assert.equal(await token(), leaked, 'a broader grant satisfies a read request');
});

test('through the shell, a failed exchange logs and answers without key, JWT or token', async () => {
  const lines = [];
  const jwts = [];
  const github = fakeGitHub({ respond: ({ jwt }) => { jwts.push(jwt); return new Response('{"token":"ghs_secretsecretsecretsecret"}', { status: 403 }); } });
  const edge = createEdge({
    release: { version: '1.0.0', commit: 'a'.repeat(40) },
    logSink: (line) => lines.push(line),
    fetch: async (req, e) => new Response(await githubAppToken(e, request(), { fetch: github.fetch, cache: new Map() })),
  });
  const response = await edge.fetch(new Request('https://demo.wizardgang.ai/sync'), { WG_APP: 'demo', ...env() }, {});
  assert.equal(response.status, 500);
  const surface = `${lines.join('\n')}\n${await response.text()}`;
  assert.match(surface, /GitHubAppError/);
  for (const secret of [jwts[0], pemBody(keys.pkcs8).slice(0, 64), 'ghs_secretsecret']) assert.ok(!surface.includes(secret));
});
