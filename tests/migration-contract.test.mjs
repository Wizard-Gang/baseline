import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sha256, validateMigrationsAt, validatePinHistory } from '../scripts/migration-contract.mjs';
import { validateRepositoryAt } from '../scripts/repository-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = 'platform/migrations';

/** A disposable copy of the repository without .git or node_modules. */
function repositoryCopy(t) {
  const copy = mkdtempSync(join(tmpdir(), 'baseline-migrations-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(root, copy, { recursive: true, filter: (source) => !/^(?:\.git|node_modules)(?:[\\/]|$)/.test(relative(root, source)) });
  return copy;
}

const pinsPath = (copy) => join(copy, MIGRATIONS, 'pins.json');
const readPins = (copy) => JSON.parse(readFileSync(pinsPath(copy), 'utf8'));
const writePins = (copy, pins) => writeFileSync(pinsPath(copy), `${JSON.stringify(pins, null, 2)}\n`);

/** Add a migration and pin it, as a correct future change would. */
function addPinned(copy, name, sql = 'CREATE INDEX records_updated ON records (app, updated_at);\n') {
  writeFileSync(join(copy, MIGRATIONS, name), sql);
  writePins(copy, { ...readPins(copy), [name]: sha256(sql) });
}

test('the committed migrations pass: one universal migration, pinned by its SHA-256', () => {
  assert.deepEqual(validateMigrationsAt(root), []);
  const pins = JSON.parse(readFileSync(join(root, MIGRATIONS, 'pins.json'), 'utf8'));
  assert.deepEqual(Object.keys(pins), ['0001_universal.sql']);
  assert.equal(pins['0001_universal.sql'], sha256(readFileSync(join(root, MIGRATIONS, '0001_universal.sql'))));
});

test('the next contiguous, pinned migration is accepted', (t) => {
  const copy = repositoryCopy(t);
  addPinned(copy, '0002_records_updated.sql');
  assert.deepEqual(validateMigrationsAt(copy), []);
  assert.deepEqual(validateRepositoryAt(copy), []);
});

test('SQL outside platform/migrations/ fails the repository contract', (t) => {
  const copy = repositoryCopy(t);
  for (const path of ['schema.sql', 'scripts/seed.sql', 'tests/fixtures/schema.SQL', 'platform/wg-edge/schema.sql', `${MIGRATIONS}/demo/0002_demo.sql`]) {
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    writeFileSync(join(copy, path), 'CREATE TABLE demo_rows (id TEXT);\n');
    assert.ok(validateRepositoryAt(copy).includes(`migrations: SQL may exist only directly under ${MIGRATIONS}/: ${path}`), path);
    rmSync(join(copy, path));
  }
  rmSync(join(copy, MIGRATIONS, 'demo'), { recursive: true });
  assert.deepEqual(validateRepositoryAt(copy), []);
});

test('out-of-sequence, duplicate-number and misnamed migrations fail', (t) => {
  const copy = repositoryCopy(t);
  const cases = [
    ['0003_skipped.sql', 'migrations: 0003_skipped.sql is out of sequence; the next migration number is 0002'],
    ['0001_again.sql', 'migrations: 0001_universal.sql is out of sequence; the next migration number is 0002'],
    ['2_short.sql', `migrations: ${MIGRATIONS}/2_short.sql is not a NNNN_name.sql migration`],
    ['0002-Dashed.sql', `migrations: ${MIGRATIONS}/0002-Dashed.sql is not a NNNN_name.sql migration`],
    ['README.md', `migrations: ${MIGRATIONS}/README.md is not a NNNN_name.sql migration`],
  ];
  for (const [name, failure] of cases) {
    const before = readPins(copy);
    addPinned(copy, name);
    assert.ok(validateRepositoryAt(copy).includes(failure), `${name}: ${validateRepositoryAt(copy)}`);
    rmSync(join(copy, MIGRATIONS, name));
    writePins(copy, before);
  }
  renameSync(join(copy, MIGRATIONS, '0001_universal.sql'), join(copy, MIGRATIONS, '0001_shared.sql'));
  assert.ok(validateMigrationsAt(copy).includes('the first migration must be 0001_universal.sql'));
  assert.ok(validateRepositoryAt(copy).includes('missing or empty repository authority: platform/migrations/0001_universal.sql'));
});

test('an edited, unpinned or removed migration fails', (t) => {
  const copy = repositoryCopy(t);
  const universal = join(copy, MIGRATIONS, '0001_universal.sql');
  const original = readFileSync(universal, 'utf8');
  writeFileSync(universal, `${original}CREATE TABLE demo_rows (id TEXT);\n`);
  assert.ok(validateRepositoryAt(copy).includes('migrations: 0001_universal.sql differs from its pin; a merged migration is never edited, add the next number instead'));
  writeFileSync(universal, original);

  const sql = 'CREATE INDEX records_updated ON records (app, updated_at);\n';
  writeFileSync(join(copy, MIGRATIONS, '0002_records_updated.sql'), sql);
  assert.ok(validateRepositoryAt(copy).includes(`migrations: 0002_records_updated.sql is not hash-pinned in pins.json (sha256 ${sha256(sql)})`));

  addPinned(copy, '0002_records_updated.sql', sql);
  rmSync(join(copy, MIGRATIONS, '0002_records_updated.sql'));
  assert.ok(validateRepositoryAt(copy).includes('migrations: pins.json pins 0002_records_updated.sql, which is missing; a merged migration is never removed or renamed'));

  for (const pins of ['not json', '[]', '{"0001_universal.sql": "abc"}']) {
    writeFileSync(pinsPath(copy), pins);
    assert.ok(validateRepositoryAt(copy).includes('migrations: platform/migrations/pins.json must map each migration file name to its SHA-256 hex digest'), pins);
  }
  rmSync(pinsPath(copy));
  assert.ok(validateRepositoryAt(copy).includes('missing or empty repository authority: platform/migrations/pins.json'));
});

test('a patch may add pins but never re-pin or drop a merged migration', () => {
  const merged = { '0001_universal.sql': 'a'.repeat(64) };
  assert.deepEqual(validatePinHistory(null, merged), []);
  assert.deepEqual(validatePinHistory(merged, merged), []);
  assert.deepEqual(validatePinHistory(merged, { ...merged, '0002_next.sql': 'b'.repeat(64) }), []);
  assert.deepEqual(validatePinHistory(merged, { '0001_universal.sql': 'c'.repeat(64) }), ['merged migration 0001_universal.sql changed its pin or was removed']);
  assert.deepEqual(validatePinHistory(merged, {}), ['merged migration 0001_universal.sql changed its pin or was removed']);
  assert.deepEqual(validatePinHistory(merged, null), ['head pins.json is missing or malformed']);
  assert.deepEqual(validatePinHistory('malformed', merged), ['base pins.json is malformed']);
});

test('check:patch fails a commit that edits a merged migration and re-pins it', (t) => {
  const copy = repositoryCopy(t);
  const git = (...args) => execFileSync('git', args, { cwd: copy, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'empty');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const universal = join(copy, MIGRATIONS, '0001_universal.sql');
  const edited = `${readFileSync(universal, 'utf8')}CREATE TABLE demo_rows (id TEXT);\n`;
  writeFileSync(universal, edited);
  writePins(copy, { '0001_universal.sql': sha256(edited) });
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-am', 'edit');
  const head = git('rev-parse', 'HEAD');
  const run = (from) => spawnSync(process.execPath, [join(copy, 'scripts/check-patch.mjs')], {
    cwd: copy, encoding: 'utf8', env: { ...process.env, PATCH_BASE_SHA: from, PATCH_HEAD_SHA: head },
  });
  const failed = run(base);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /FAIL merged migration 0001_universal\.sql changed its pin or was removed/);
  const fresh = run(git('rev-parse', 'HEAD~2'));
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /Merged migration pins unchanged/);
});
