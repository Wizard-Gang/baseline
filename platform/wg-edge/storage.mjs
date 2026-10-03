// Storage helpers for the shared `wizardgang` D1 database (binding WG_DB) and R2 bucket (binding WG_R2).
// Every query binds `app` from the Worker's own WG_APP and every key is prefixed `<app>/`. The helpers
// take no app argument, so an app can never address another app's rows or objects.
// Times are integer milliseconds since the epoch. Baseline owns the schema; see README.md for the columns.
import { ConfigurationError, workerIdentity } from './workers.mjs';

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_ID = 256;
const MAX_BODY = 1_000_000;
const MAX_LIMIT = 1000;

/** @param {string} label @param {unknown} value */
function name(label, value) {
  if (typeof value !== 'string' || !NAME.test(value)) throw new TypeError(`${label} must match ${NAME}`);
  return value;
}

/** @param {unknown} value */
function recordId(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_ID || /[\u0000-\u001f]/.test(value)) {
    throw new TypeError(`id must be 1-${MAX_ID} printable characters`);
  }
  return value;
}

/** @param {unknown} body */
function encode(body) {
  const encoded = JSON.stringify(body);
  if (encoded === undefined) throw new TypeError('body must be JSON-serializable');
  if (encoded.length > MAX_BODY) throw new TypeError('body exceeds 1 MB');
  return encoded;
}

/** @param {number} now @param {unknown} ttlSeconds */
function expiry(now, ttlSeconds) {
  if (ttlSeconds === undefined || ttlSeconds === null) return null;
  if (!Number.isInteger(ttlSeconds) || /** @type {number} */ (ttlSeconds) <= 0) throw new TypeError('ttlSeconds must be a positive integer');
  return now + /** @type {number} */ (ttlSeconds) * 1000;
}

/** @param {unknown} value */
function limit(value) {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || /** @type {number} */ (value) < 1 || /** @type {number} */ (value) > MAX_LIMIT) {
    throw new TypeError(`limit must be 1-${MAX_LIMIT}`);
  }
  return /** @type {number} */ (value);
}

/** @param {any} env */
function database(env) {
  if (typeof env?.WG_DB?.prepare !== 'function') throw new ConfigurationError('WG_DB must be the wizardgang D1 binding');
  return env.WG_DB;
}

/** @param {any} row */
function toRecord(row) {
  return row && {
    collection: row.collection, id: row.id, body: JSON.parse(row.body), owner: row.owner ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at ?? null,
  };
}

const LIVE = '(expires_at IS NULL OR expires_at > ?)';
const RECORD_COLUMNS = 'collection, id, body, owner, created_at, updated_at, expires_at';

/**
 * Records for this Worker's app. Expired rows read as absent before the sweeper deletes them.
 * @param {any} env
 * @param {{ now?: () => number }} [options]
 */
export function records(env, { now = Date.now } = {}) {
  const { app } = workerIdentity(env);
  const db = database(env);
  return Object.freeze({
    async get(collection, id) {
      const row = await db.prepare(`SELECT ${RECORD_COLUMNS} FROM records WHERE app = ? AND collection = ? AND id = ? AND ${LIVE}`)
        .bind(app, name('collection', collection), recordId(id), now()).first();
      return toRecord(row) ?? null;
    },
    async put(collection, id, body, { owner = null, ttlSeconds } = {}) {
      if (owner !== null && (typeof owner !== 'string' || !owner || owner.length > MAX_ID)) throw new TypeError('owner must be a short string or null');
      const at = now();
      await db.prepare('INSERT INTO records (app, collection, id, body, owner, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT (app, collection, id) DO UPDATE SET body = excluded.body, owner = excluded.owner, updated_at = excluded.updated_at, expires_at = excluded.expires_at')
        .bind(app, name('collection', collection), recordId(id), encode(body), owner, at, at, expiry(at, ttlSeconds)).run();
    },
    async delete(collection, id) {
      const result = await db.prepare('DELETE FROM records WHERE app = ? AND collection = ? AND id = ?')
        .bind(app, name('collection', collection), recordId(id)).run();
      return (result?.meta?.changes ?? 0) > 0;
    },
    async list(collection, { owner, limit: count } = {}) {
      if (owner !== undefined && typeof owner !== 'string') throw new TypeError('owner filter must be a string');
      const byOwner = owner === undefined ? '' : ' AND owner = ?';
      const values = [app, name('collection', collection), ...(owner === undefined ? [] : [owner]), now(), limit(count)];
      const { results = [] } = await db.prepare(`SELECT ${RECORD_COLUMNS} FROM records WHERE app = ? AND collection = ?${byOwner} AND ${LIVE} ORDER BY id LIMIT ?`)
        .bind(...values).all();
      return results.map(toRecord);
    },
  });
}

/**
 * Append-only events for this Worker's app.
 * @param {any} env
 * @param {{ now?: () => number }} [options]
 */
export function events(env, { now = Date.now } = {}) {
  const { app } = workerIdentity(env);
  const db = database(env);
  return Object.freeze({
    async append(kind, body, { ttlSeconds } = {}) {
      const at = now();
      await db.prepare('INSERT INTO events (app, kind, at, body, expires_at) VALUES (?, ?, ?, ?, ?)')
        .bind(app, name('kind', kind), at, encode(body), expiry(at, ttlSeconds)).run();
      return at;
    },
    async list(kind, { since = 0, limit: count } = {}) {
      if (!Number.isInteger(since) || since < 0) throw new TypeError('since must be a non-negative integer');
      const { results = [] } = await db.prepare(`SELECT kind, at, body, expires_at FROM events WHERE app = ? AND kind = ? AND at >= ? AND ${LIVE} ORDER BY at, rowid LIMIT ?`)
        .bind(app, name('kind', kind), since, now(), limit(count)).all();
      return results.map((row) => ({ kind: row.kind, at: row.at, body: JSON.parse(row.body), expiresAt: row.expires_at ?? null }));
    },
  });
}

/**
 * The TTL sweeper. Call it from the app's scheduled handler; it deletes only this app's expired rows.
 * @param {any} env
 * @param {{ now?: () => number }} [options]
 */
export async function sweepExpired(env, { now = Date.now } = {}) {
  const { app } = workerIdentity(env);
  const db = database(env);
  const at = now();
  const deleted = {};
  for (const table of /** @type {const} */ (['records', 'events'])) {
    const result = await db.prepare(`DELETE FROM ${table} WHERE app = ? AND expires_at IS NOT NULL AND expires_at <= ?`).bind(app, at).run();
    deleted[table] = result?.meta?.changes ?? 0;
  }
  return /** @type {{ records: number, events: number }} */ (deleted);
}

/** @param {unknown} key */
function objectKey(key) {
  if (typeof key !== 'string' || !key || key.length > 512 || key.startsWith('/') || /[\u0000-\u001f\\]/.test(key)
    || key.split('/').some((part) => part === '.' || part === '..' || part === '')) {
    throw new TypeError('key must be a relative path without empty, . or .. segments');
  }
  return key;
}

/**
 * The R2 bucket seen through this app's `<app>/` prefix. Objects come back exactly as R2 returns them;
 * `list` adds `keys`, the listed keys relative to the prefix.
 * @param {any} env
 */
export function bucket(env) {
  const { prefix } = workerIdentity(env);
  const r2 = env?.WG_R2;
  if (typeof r2?.get !== 'function') throw new ConfigurationError('WG_R2 must be the wizardgang R2 binding');
  const full = (/** @type {unknown} */ key) => prefix + objectKey(key);
  return Object.freeze({
    prefix,
    get(key, options) { return r2.get(full(key), options); },
    head(key) { return r2.head(full(key)); },
    put(key, value, options) { return r2.put(full(key), value, options); },
    async delete(key) { await r2.delete(full(key)); },
    async list({ prefix: within = '', cursor, limit: count } = {}) {
      if (typeof within !== 'string' || within.startsWith('/') || within.split('/').some((part) => part === '.' || part === '..')) {
        throw new TypeError('list prefix must stay inside the app prefix');
      }
      const listed = await r2.list({ prefix: prefix + within, cursor, limit: limit(count) });
      const keys = listed.objects.map((/** @type {{ key: string }} */ object) => object.key.slice(prefix.length));
      return { objects: listed.objects, keys, truncated: listed.truncated, cursor: listed.truncated ? listed.cursor : undefined };
    },
  });
}
