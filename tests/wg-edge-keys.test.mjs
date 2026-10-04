import assert from 'node:assert/strict';
import { hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ConfigurationError, DERIVED_KEYS, deriveKey } from '../platform/wg-edge/index.mjs';

const registry = JSON.parse(readFileSync(new URL('../config/secrets.json', import.meta.url), 'utf8'));
// A fresh root per run: no committed key exists, and every assertion holds for any root.
const root = randomBytes(32).toString('base64');
const env = (overrides = {}) => ({ WG_APP: 'demo', WG_SESSION_KEY: root, ...overrides });
const hex = (bytes) => Buffer.from(bytes).toString('hex');

async function rejectsClosed(promise, message, secret = root) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ConfigurationError, `expected ConfigurationError, got ${error?.name}`);
    assert.match(error.message, message);
    assert.ok(!JSON.stringify({ message: error.message, stack: error.stack }).includes(secret), 'the error carries key material');
    return true;
  });
}

test('the label table mirrors the registry derived entries exactly, consumers included', () => {
  const derived = registry.entries.filter((entry) => entry.kind === 'derived');
  assert.ok(derived.every((entry) => entry.source === 'WG_SESSION_KEY'));
  const expected = Object.fromEntries(derived.map((entry) => [entry.name, { consumers: entry.consumers }]));
  assert.deepEqual(JSON.parse(JSON.stringify(DERIVED_KEYS)), expected);
  assert.deepEqual(Object.keys(DERIVED_KEYS).sort(), ['demo-session', 'identity-audit', 'identity-session']);
  assert.ok(Object.isFrozen(DERIVED_KEYS) && Object.values(DERIVED_KEYS).every((entry) => Object.isFrozen(entry.consumers)));
});

test('derivation is HKDF-SHA256 over WG_SESSION_KEY with the documented salt and per-label info', async () => {
  for (const label of Object.keys(DERIVED_KEYS)) {
    const expected = hkdfSync('sha256', Buffer.from(root, 'utf8'), 'wizardgang wg-edge derived key v1', `wg-edge:${label}`, 32);
    assert.equal(hex(await deriveKey(env(), label)), Buffer.from(expected).toString('hex'), label);
  }
});

test('derivation is deterministic per label, from a plain secret or a Secrets Store binding', async () => {
  const first = await deriveKey(env(), 'demo-session');
  assert.ok(first instanceof Uint8Array);
  assert.equal(first.length, 32);
  assert.equal(hex(await deriveKey(env(), 'demo-session')), hex(first));
  const store = { async get() { return root; } };
  assert.equal(hex(await deriveKey(env({ WG_SESSION_KEY: store }), 'demo-session')), hex(first));
});

test('labels and roots are separated', async () => {
  const keys = await Promise.all(Object.keys(DERIVED_KEYS).map((label) => deriveKey(env(), label)));
  assert.equal(new Set(keys.map(hex)).size, keys.length);
  const other = await deriveKey(env({ WG_SESSION_KEY: randomBytes(32).toString('base64') }), 'demo-session');
  assert.notEqual(hex(other), hex(keys[0]));
  for (const key of keys) assert.ok(!Buffer.from(key).toString('utf8').includes(root));
});

test('an undeclared label fails closed', async () => {
  for (const label of ['admin-session', 'DEMO_SESSION_SECRET', '__proto__', 'constructor', '', undefined, 7]) {
    await rejectsClosed(deriveKey(env(), label), /not declared in the secret registry/);
  }
});

test('a Worker that is not a consumer of the label, or has no declared identity, fails closed', async () => {
  await rejectsClosed(deriveKey(env({ WG_APP: 'hexframe' }), 'identity-audit'), /not a consumer/);
  await rejectsClosed(deriveKey(env({ WG_APP: 'portfolio' }), 'demo-session'), /WG_APP must name a declared Worker/);
});

test('a missing, empty or unreadable WG_SESSION_KEY fails closed without leaking', async () => {
  const unreadable = { async get() { throw new Error(`store said ${root}`); } };
  for (const value of [undefined, '', null, 42, { async get() { return ''; } }, unreadable]) {
    await rejectsClosed(deriveKey(env({ WG_SESSION_KEY: value }), 'demo-session'), /^WG_SESSION_KEY is not configured$/);
  }
});
