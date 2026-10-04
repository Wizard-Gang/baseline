// Test doubles for wg-edge: a D1 binding backed by node:sqlite, an in-memory R2, freshly generated RSA keys and a fake
// GitHub installation-token endpoint.
// The D1 fake is built from platform/migrations/, so every helper test runs against the real schema.
import { generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = new URL('../../platform/migrations/', import.meta.url);

/** Apply every committed migration, in file-name order, to a node:sqlite database. */
export function applyMigrations(db) {
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  }
  return db;
}

/** A D1-shaped binding: prepare().bind().first()/all()/run(), with every executed statement recorded. */
export function fakeD1() {
  const db = applyMigrations(new DatabaseSync(':memory:'));
  const statements = [];
  return {
    db,
    statements,
    prepare(sql) {
      const statement = db.prepare(sql);
      const bound = (values) => ({
        async first() { statements.push({ sql, values }); return statement.get(...values) ?? null; },
        async all() { statements.push({ sql, values }); return { success: true, results: statement.all(...values) }; },
        async run() { statements.push({ sql, values }); return { success: true, meta: { changes: Number(statement.run(...values).changes) } }; },
      });
      return { bind: (...values) => bound(values), ...bound([]) };
    },
  };
}

/** An R2-shaped binding over a Map, with list prefix, limit and cursor semantics. */
export function fakeR2() {
  const objects = new Map();
  const calls = [];
  const view = (key) => {
    const stored = objects.get(key);
    return stored && { key, size: stored.body.length, httpMetadata: stored.httpMetadata, async text() { return stored.body; } };
  };
  return {
    objects,
    calls,
    async get(key) { calls.push(['get', key]); return view(key) ?? null; },
    async head(key) { calls.push(['head', key]); return view(key) ?? null; },
    async put(key, value, options = {}) {
      calls.push(['put', key]);
      objects.set(key, { body: String(value), httpMetadata: options.httpMetadata });
      return view(key);
    },
    async delete(key) { calls.push(['delete', key]); objects.delete(key); },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      calls.push(['list', prefix]);
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return { objects: page.map(view), truncated, ...(truncated ? { cursor: String(start + limit) } : {}) };
    },
  };
}

/** A throwaway RSA key pair generated per call; no committed key exists. `pkcs1` is GitHub's download format. */
export function rsaKeys(modulusLength = 2048) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength });
  return {
    pkcs8: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    pkcs1: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    publicKey,
  };
}

/**
 * A fetch double for POST /app/installations/<id>/access_tokens. Each call is recorded with its JWT; `respond` may
 * replace the default 201, which grants exactly the requested permissions for one hour from `now()`.
 */
export function fakeGitHub({ now = () => Date.now(), respond } = {}) {
  const calls = [];
  let issued = 0;
  async function fetch(url, init) {
    const body = JSON.parse(init.body);
    const jwt = init.headers.authorization.replace(/^Bearer /, '');
    calls.push({ url, method: init.method, headers: init.headers, body, jwt });
    if (respond) return respond({ url, body, jwt, call: calls.length });
    issued += 1;
    const token = `ghs_${String(issued).padStart(36, '0')}`;
    const expires_at = new Date(now() + 3_600_000).toISOString();
    return new Response(JSON.stringify({ token, expires_at, permissions: body.permissions, repository_selection: 'selected' }), { status: 201 });
  }
  return { fetch, calls };
}
