import assert from 'node:assert/strict';
import test from 'node:test';
import { bucket, events, records, sweepExpired } from '../platform/wg-edge/index.mjs';
import { fakeD1, fakeR2 } from './fixtures/wg-edge-fakes.mjs';

const T0 = 1_790_000_000_000;
const clock = (at) => ({ now: () => at });

test('records round-trip with owner, TTL and upsert, scoped to WG_APP', async () => {
  const WG_DB = fakeD1();
  const demo = records({ WG_APP: 'demo', WG_DB }, clock(T0));
  await demo.put('notes', 'n1', { text: 'hi' }, { owner: 'u1', ttlSeconds: 60 });
  assert.deepEqual(await demo.get('notes', 'n1'), {
    collection: 'notes', id: 'n1', body: { text: 'hi' }, owner: 'u1', createdAt: T0, updatedAt: T0, expiresAt: T0 + 60_000,
  });
  await records({ WG_APP: 'demo', WG_DB }, clock(T0 + 5)).put('notes', 'n1', { text: 'edited' });
  const edited = await demo.get('notes', 'n1');
  assert.deepEqual([edited.body, edited.owner, edited.createdAt, edited.updatedAt, edited.expiresAt], [{ text: 'edited' }, null, T0, T0 + 5, null]);
  await demo.put('notes', 'n2', [1, 2], { owner: 'u2' });
  assert.deepEqual((await demo.list('notes')).map((row) => row.id), ['n1', 'n2']);
  assert.deepEqual((await demo.list('notes', { owner: 'u2' })).map((row) => row.id), ['n2']);
  assert.deepEqual((await demo.list('notes', { limit: 1 })).map((row) => row.id), ['n1']);
  assert.equal(await demo.delete('notes', 'n2'), true);
  assert.equal(await demo.delete('notes', 'n2'), false);
  assert.ok(WG_DB.statements.every(({ sql, values }) => /\bapp = \?|VALUES \(\?/.test(sql) && values[0] === 'demo'));
});

test('no app can read, list, overwrite or delete another app\'s rows', async () => {
  const WG_DB = fakeD1();
  const demo = records({ WG_APP: 'demo', WG_DB }, clock(T0));
  const shark = records({ WG_APP: 'sharktank', WG_DB }, clock(T0));
  await demo.put('shared', 'same-id', { from: 'demo' });
  await shark.put('shared', 'same-id', { from: 'sharktank' });
  assert.deepEqual((await demo.get('shared', 'same-id')).body, { from: 'demo' });
  assert.deepEqual((await shark.get('shared', 'same-id')).body, { from: 'sharktank' });
  await shark.put('only-shark', 'x', 1);
  assert.equal(await demo.get('only-shark', 'x'), null);
  assert.deepEqual(await demo.list('only-shark'), []);
  assert.equal(await demo.delete('only-shark', 'x'), false);
  assert.equal(await shark.delete('shared', 'same-id'), true);
  assert.deepEqual((await demo.get('shared', 'same-id')).body, { from: 'demo' });

  const demoEvents = events({ WG_APP: 'demo', WG_DB }, clock(T0));
  await events({ WG_APP: 'hexframe', WG_DB }, clock(T0)).append('match', { score: 9 });
  await demoEvents.append('match', { score: 1 });
  assert.deepEqual((await demoEvents.list('match')).map((event) => event.body), [{ score: 1 }]);
  const rows = WG_DB.db.prepare('SELECT app, COUNT(*) AS n FROM records GROUP BY app ORDER BY app').all();
  assert.deepEqual(rows.map((row) => [row.app, row.n]), [['demo', 1], ['sharktank', 1]]);
});

test('helpers reject an undeclared app, a missing binding and malformed names', async () => {
  const WG_DB = fakeD1();
  assert.throws(() => records({ WG_APP: 'other', WG_DB }), /declared Worker/);
  assert.throws(() => events({ WG_DB }), /declared Worker/);
  assert.throws(() => records({ WG_APP: 'demo' }), /WG_DB/);
  assert.throws(() => bucket({ WG_APP: 'demo' }), /WG_R2/);
  const demo = records({ WG_APP: 'demo', WG_DB });
  for (const collection of ['', 'Upper', 'has space', '1lead', 'x'.repeat(65), 42]) {
    await assert.rejects(demo.put(collection, 'id', {}), /collection/);
  }
  for (const id of ['', 'x'.repeat(257), 'bad\nid', 7]) await assert.rejects(demo.get('notes', id), /id must/);
  await assert.rejects(demo.put('notes', 'a', undefined), /JSON/);
  await assert.rejects(demo.put('notes', 'a', 'x'.repeat(1_000_001)), /1 MB/);
  for (const ttlSeconds of [0, -1, 1.5, '60']) await assert.rejects(demo.put('notes', 'a', 1, { ttlSeconds }), /ttlSeconds/);
  await assert.rejects(demo.list('notes', { limit: 1001 }), /limit/);
  await assert.rejects(demo.list('notes', { owner: 5 }), /owner/);
  await assert.rejects(events({ WG_APP: 'demo', WG_DB }).list('k', { since: -1 }), /since/);
});

test('expired rows read as absent before the sweep', async () => {
  const WG_DB = fakeD1();
  await records({ WG_APP: 'demo', WG_DB }, clock(T0)).put('s', 'gone', 1, { ttlSeconds: 1 });
  await events({ WG_APP: 'demo', WG_DB }, clock(T0)).append('e', 1, { ttlSeconds: 1 });
  const later = { WG_APP: 'demo', WG_DB };
  assert.equal(await records(later, clock(T0 + 1000)).get('s', 'gone'), null);
  assert.deepEqual(await records(later, clock(T0 + 1000)).list('s'), []);
  assert.deepEqual(await events(later, clock(T0 + 1000)).list('e'), []);
  assert.equal((await records(later, clock(T0 + 999)).get('s', 'gone')).body, 1);
});

test('the sweeper deletes only its own app\'s expired rows', async () => {
  const WG_DB = fakeD1();
  for (const app of ['demo', 'sharktank']) {
    const env = { WG_APP: app, WG_DB };
    await records(env, clock(T0)).put('s', 'short', 1, { ttlSeconds: 10 });
    await records(env, clock(T0)).put('s', 'long', 1, { ttlSeconds: 3600 });
    await records(env, clock(T0)).put('s', 'forever', 1);
    await events(env, clock(T0)).append('e', 1, { ttlSeconds: 10 });
    await events(env, clock(T0)).append('e', 2);
  }
  assert.deepEqual(await sweepExpired({ WG_APP: 'demo', WG_DB }, clock(T0 + 10_000)), { records: 1, events: 1 });
  assert.deepEqual(await sweepExpired({ WG_APP: 'demo', WG_DB }, clock(T0 + 10_000)), { records: 0, events: 0 });
  const count = (table, app) => WG_DB.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE app = ?`).get(app).n;
  assert.deepEqual([count('records', 'demo'), count('events', 'demo')], [2, 1]);
  assert.deepEqual([count('records', 'sharktank'), count('events', 'sharktank')], [3, 2]);
  assert.deepEqual(await sweepExpired({ WG_APP: 'sharktank', WG_DB }, clock(T0 + 3_600_000)), { records: 2, events: 1 });
  assert.equal(count('records', 'demo'), 2);
  await assert.rejects(sweepExpired({ WG_APP: 'all', WG_DB }), /declared Worker/);
});

test('R2 keys live under <app>/ and cannot reach another app\'s prefix', async () => {
  const WG_R2 = fakeR2();
  const demo = bucket({ WG_APP: 'demo', WG_R2 });
  const hex = bucket({ WG_APP: 'hexframe', WG_R2 });
  assert.equal(demo.prefix, 'demo/');
  await demo.put('uploads/a.pdf', 'demo-bytes', { httpMetadata: { contentType: 'application/pdf' } });
  await hex.put('uploads/a.pdf', 'hex-bytes');
  assert.deepEqual([...WG_R2.objects.keys()].sort(), ['demo/uploads/a.pdf', 'hexframe/uploads/a.pdf']);
  assert.equal(await (await demo.get('uploads/a.pdf')).text(), 'demo-bytes');
  assert.equal((await hex.head('uploads/a.pdf')).key, 'hexframe/uploads/a.pdf');
  await hex.delete('uploads/a.pdf');
  assert.equal(await (await demo.get('uploads/a.pdf')).text(), 'demo-bytes');

  for (const key of ['', '/demo/x', '../hexframe/x', 'a/../../hexframe/x', 'a//b', './x', 'a\\b', 'x\n', 'a/', 5]) {
    await assert.rejects(async () => demo.get(key), /key must/, String(key));
  }
  for (const prefix of ['../', '/', 'a/../..']) await assert.rejects(async () => demo.list({ prefix }), /inside the app prefix/);
  assert.ok(WG_R2.calls.every(([, key]) => key.startsWith('demo/') || key.startsWith('hexframe/')));
});

test('R2 list stays inside the prefix and pages with a cursor', async () => {
  const WG_R2 = fakeR2();
  for (const key of ['demo/a', 'demo/b', 'demo/c', 'demo-other/x', 'demonstration/y', 'sharktank/z']) await WG_R2.put(key, key);
  const demo = bucket({ WG_APP: 'demo', WG_R2 });
  const first = await demo.list({ limit: 2 });
  assert.deepEqual(first.keys, ['a', 'b']);
  assert.equal(first.truncated, true);
  const second = await demo.list({ limit: 2, cursor: first.cursor });
  assert.deepEqual([second.keys, second.truncated, second.cursor], [['c'], false, undefined]);
  assert.deepEqual((await demo.list({ prefix: 'b' })).keys, ['b']);
  assert.deepEqual(WG_R2.calls.filter(([call]) => call === 'list').map(([, prefix]) => prefix), ['demo/', 'demo/', 'demo/b']);
});
