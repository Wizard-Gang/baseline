import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { events, records, sweepExpired } from '../platform/wg-edge/index.mjs';
import { applyMigrations, fakeD1 } from './fixtures/wg-edge-fakes.mjs';

const T0 = 1_790_000_000_000;
const clock = (at) => ({ now: () => at });
const universal = readFileSync(new URL('../platform/migrations/0001_universal.sql', import.meta.url), 'utf8');

// [name, type, notnull, primary-key position]
const COLUMNS = {
  records: [
    ['app', 'TEXT', 1, 1], ['collection', 'TEXT', 1, 2], ['id', 'TEXT', 1, 3], ['body', 'TEXT', 1, 0],
    ['owner', 'TEXT', 0, 0], ['created_at', 'INTEGER', 1, 0], ['updated_at', 'INTEGER', 1, 0], ['expires_at', 'INTEGER', 0, 0],
  ],
  events: [['app', 'TEXT', 1, 0], ['kind', 'TEXT', 1, 0], ['at', 'INTEGER', 1, 0], ['body', 'TEXT', 1, 0], ['expires_at', 'INTEGER', 0, 0]],
};
const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => [row.name, row.type, row.notnull, row.pk]);
const names = (table) => COLUMNS[table].map(([column]) => column);

/** Exercise every records, events and sweeper operation, returning the fake with its recorded statements. */
async function everyHelperOperation() {
  const WG_DB = fakeD1();
  const env = { WG_APP: 'demo', WG_DB };
  const rows = records(env, clock(T0));
  await rows.put('notes', 'n1', { text: 'hi' }, { owner: 'u1', ttlSeconds: 60 });
  await rows.put('notes', 'n2', [1, 2]);
  await rows.get('notes', 'n1');
  await rows.list('notes');
  await rows.list('notes', { owner: 'u1', limit: 5 });
  await rows.delete('notes', 'n2');
  const log = events(env, clock(T0));
  await log.append('match', { score: 1 }, { ttlSeconds: 60 });
  await log.list('match', { since: T0 - 1 });
  await sweepExpired(env, clock(T0 + 120_000));
  return WG_DB;
}

test('the universal migration applies cleanly to a fresh database and creates only the shared tables', () => {
  const db = applyMigrations(new DatabaseSync(':memory:'));
  const objects = db.prepare("SELECT type, name, tbl_name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
    .map((row) => [row.type, row.name, row.tbl_name]);
  assert.deepEqual(objects, [
    ['index', 'events_app_time', 'events'], ['index', 'events_expiry', 'events'],
    ['index', 'records_expiry', 'records'], ['index', 'records_owner', 'records'],
    ['table', 'events', 'events'], ['table', 'records', 'records'],
  ]);
  for (const table of ['records', 'events']) assert.deepEqual(columnsOf(db, table), COLUMNS[table], table);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_list WHERE strict = 1 AND name IN ('records', 'events')").get().n, 2);
  // D1 applies a migration as one batch and rejects explicit transaction control.
  assert.doesNotMatch(universal, /\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|TRANSACTION|PRAGMA|ATTACH)\b/i);
});

test('the schema columns are exactly the columns the wg-edge helpers read and write', async () => {
  const { statements } = await everyHelperOperation();
  const kinds = new Set(statements.map(({ sql }) => sql.split(' ')[0]));
  assert.deepEqual([...kinds].sort(), ['DELETE', 'INSERT', 'SELECT']);
  const written = { records: new Set(), events: new Set() };
  const read = { records: new Set(), events: new Set() };
  for (const { sql } of statements) {
    const table = /\b(?:INTO|FROM) (records|events)\b/.exec(sql)?.[1];
    assert.ok(table, `helper statement names a shared table: ${sql}`);
    const insert = /^INSERT INTO \w+ \(([^)]+)\)/.exec(sql);
    if (insert) for (const column of insert[1].split(', ')) written[table].add(column);
    const select = /^SELECT (.+?) FROM/.exec(sql);
    if (select) for (const column of select[1].split(', ')) read[table].add(column);
    for (const [, column] of sql.matchAll(/\b([a-z_]+) (?:=|>=|<=|>|IS)(?: |$)/g)) {
      if (column !== 'excluded') assert.ok(names(table).includes(column), `${table}.${column} is a schema column`);
    }
  }
  for (const table of ['records', 'events']) {
    assert.deepEqual([...written[table]].sort(), names(table).sort(), `${table}: every column is written`);
    assert.deepEqual([...read[table]].sort(), names(table).filter((column) => column !== 'app').sort(), `${table}: every non-app column is read`);
  }
});

test('every helper read and delete is an index search, never a table scan or sort', async () => {
  const WG_DB = await everyHelperOperation();
  const queries = [...new Set(WG_DB.statements.map(({ sql }) => sql).filter((sql) => !sql.startsWith('INSERT')))];
  assert.equal(queries.length, 7);
  const used = new Set();
  for (const sql of queries) {
    const plan = WG_DB.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail);
    assert.ok(plan.length && plan.every((detail) => /^SEARCH (records|events) USING (?:COVERING )?INDEX /.test(detail)), `${sql}\n${plan}`);
    for (const detail of plan) used.add(/INDEX (\w+)/.exec(detail)[1]);
  }
  for (const index of ['records_owner', 'records_expiry', 'events_app_time', 'events_expiry']) assert.ok(used.has(index), index);
});

test('the schema keeps JSON bodies verbatim and times as integer milliseconds', async () => {
  const WG_DB = fakeD1();
  const env = { WG_APP: 'demo', WG_DB };
  await records(env, clock(T0)).put('s', 'one', 1);
  await records(env, clock(T0 + 7)).put('s', 'one', '1', { ttlSeconds: 5 });
  const row = WG_DB.db.prepare('SELECT body, typeof(body) AS b, typeof(created_at) AS c, typeof(updated_at) AS u, typeof(expires_at) AS e, created_at, updated_at FROM records').get();
  assert.deepEqual({ ...row }, { body: '"1"', b: 'text', c: 'integer', u: 'integer', e: 'integer', created_at: T0, updated_at: T0 + 7 });
  assert.equal((await records(env, clock(T0 + 8)).get('s', 'one')).body, '1');

  const insert = WG_DB.db.prepare('INSERT INTO events (app, kind, at, body, expires_at) VALUES (?, ?, ?, ?, ?)');
  insert.run('demo', 'k', T0, '{"ok":true}', null);
  assert.throws(() => insert.run('demo', 'k', T0 + 0.5, '1', null), /INTEGER/);
  assert.throws(() => insert.run('demo', 'k', 'soon', '1', null), /INTEGER/);
  assert.throws(() => insert.run('demo', 'k', T0, '{not json', null), /json_valid/);
  assert.throws(() => insert.run('', 'k', T0, '1', null), /CHECK/);
  const upsert = WG_DB.db.prepare('INSERT INTO records (app, collection, id, body, owner, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  assert.throws(() => upsert.run('demo', 's', 'two', '1', null, T0, T0 - 1, null), /CHECK/);
  assert.throws(() => upsert.run('demo', 's', 'one', '1', null, T0, T0, null), /UNIQUE|PRIMARY KEY/);
});
