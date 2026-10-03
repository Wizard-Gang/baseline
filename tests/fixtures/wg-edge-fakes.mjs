// Test doubles for the wg-edge storage helpers: a D1 binding backed by node:sqlite and an in-memory R2.
import { DatabaseSync } from 'node:sqlite';

// Test-only stand-in for the shared schema. The universal migration (BASE-019) owns the real DDL.
const TEST_SCHEMA = `
  CREATE TABLE records (app TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
    owner TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER,
    PRIMARY KEY (app, collection, id));
  CREATE TABLE events (app TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, expires_at INTEGER);
`;

/** A D1-shaped binding: prepare().bind().first()/all()/run(), with every executed statement recorded. */
export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(TEST_SCHEMA);
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
