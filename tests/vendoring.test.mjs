import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../platform/conformance/cli.mjs';
import { buildLock, compareVendored, formatLock, LOCK_FILE, sha256, verifyVendored } from '../platform/conformance/vendor.mjs';
import { lockForCommit } from '../scripts/vendor-lock.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const platform = join(root, 'platform');
const COMMIT = 'a'.repeat(40);
const author = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];

function temp(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A baseline-shaped source repository holding the working-tree platform/ in one commit. */
function sourceRepository(t) {
  const source = temp(t, 'baseline-vendor-source-');
  cpSync(platform, join(source, 'platform'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git(...author, 'commit', '-q', '-m', 'platform');
  return { source, git, commit: git('rev-parse', 'HEAD') };
}

/** A consumer checkout with platform/ vendored from the source commit and its printed lock. */
function consumer(t) {
  const { source, commit } = sourceRepository(t);
  const copy = temp(t, 'baseline-vendor-consumer-');
  cpSync(join(source, 'platform'), join(copy, 'platform'), { recursive: true });
  writeFileSync(join(copy, 'platform', LOCK_FILE), lockForCommit(commit, source));
  return { copy, commit };
}

const pin = (copy) => spawnSync(process.execPath, [join(copy, 'platform/conformance/cli.mjs'), 'pin'], { cwd: copy, encoding: 'utf8' });

test('the lock printer pins every platform/ file at the named commit', (t) => {
  const { source, git, commit } = sourceRepository(t);
  const lock = JSON.parse(lockForCommit('HEAD', source));
  assert.equal(lock.commit, commit);
  assert.equal(lock.source, 'Wizard-Gang/baseline');
  const tracked = git('ls-files', 'platform').split('\n').map((path) => path.slice('platform/'.length)).sort();
  assert.deepEqual(Object.keys(lock.files), tracked);
  for (const path of tracked) assert.equal(lock.files[path], sha256(readFileSync(join(platform, path))), path);
  assert.ok(tracked.includes('conformance/cli.mjs') && tracked.includes('wrangler.template.jsonc') && tracked.includes('migrations/0001_universal.sql'));

  // A later commit does not change the lock printed for the earlier one.
  appendFileSync(join(source, 'platform/wg-edge/README.md'), '\nlater\n');
  git(...author, 'commit', '-q', '-am', 'later');
  assert.equal(lockForCommit(commit, source), formatLock(lock));
  assert.notEqual(lockForCommit('HEAD', source), formatLock(lock));
  assert.throws(() => lockForCommit('--output=x', source), /give the baseline commit/);
  assert.throws(() => lockForCommit('no-such-ref', source), /git rev-parse failed/);
});

test('the npm script prints the lock and fails without a commit', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['vendor:lock'], 'node scripts/vendor-lock.mjs');
  const missing = spawnSync(process.execPath, [join(root, 'scripts/vendor-lock.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /give the baseline commit/);
});

test('an exact vendored copy passes from the consumer root', (t) => {
  const { copy, commit } = consumer(t);
  assert.deepEqual(verifyVendored(copy), []);
  const result = pin(copy);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Vendored platform\/ matches platform\/vendor\.lock\.json/);
  assert.equal(JSON.parse(readFileSync(join(copy, 'platform', LOCK_FILE), 'utf8')).commit, commit);
});

test('a tampered vendored file fails', (t) => {
  const { copy } = consumer(t);
  appendFileSync(join(copy, 'platform/wg-edge/auth.mjs'), '\nexport const bypass = true;\n');
  writeFileSync(join(copy, 'platform/conformance/desired.mjs'), readFileSync(join(platform, 'conformance/desired.mjs'), 'utf8').replace("'2026-08-31'", "'2026-06-28'"));
  const failures = verifyVendored(copy);
  assert.ok(failures.some((failure) => /^platform\/wg-edge\/auth\.mjs differs from baseline [0-9a-f]{40}; never edit vendored files$/.test(failure)));
  assert.ok(failures.some((failure) => /^platform\/conformance\/desired\.mjs differs/.test(failure)));
  const result = pin(join(copy));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL platform\/wg-edge\/auth\.mjs differs/);
});

test('a partial vendored copy fails', (t) => {
  const { copy } = consumer(t);
  rmSync(join(copy, 'platform/migrations'), { recursive: true });
  rmSync(join(copy, 'platform/wrangler.template.jsonc'));
  const failures = verifyVendored(copy);
  for (const path of ['migrations/0001_universal.sql', 'migrations/pins.json', 'wrangler.template.jsonc']) {
    assert.ok(failures.includes(`platform/${path} is pinned but missing`), path);
  }
  rmSync(join(copy, 'platform', LOCK_FILE));
  assert.match(verifyVendored(copy)[0], /vendor\.lock\.json is missing; print it with baseline npm run vendor:lock/);
  rmSync(join(copy, 'platform'), { recursive: true });
  assert.deepEqual(verifyVendored(copy), ['platform/ must be a vendored directory']);
});

test('an unpinned or non-regular file fails', (t) => {
  const { copy } = consumer(t);
  mkdirSync(join(copy, 'platform/app'));
  writeFileSync(join(copy, 'platform/app/routes.mjs'), 'export {};\n');
  writeFileSync(join(copy, 'platform/migrations/0002_demo.sql'), 'CREATE TABLE demo (id TEXT);\n');
  symlinkSync('wg-edge/index.mjs', join(copy, 'platform/edge.mjs'));
  const failures = verifyVendored(copy);
  assert.ok(failures.includes('platform/app/routes.mjs is not pinned; vendored platform/ must match baseline exactly'));
  assert.ok(failures.includes('platform/migrations/0002_demo.sql is not pinned; vendored platform/ must match baseline exactly'));
  assert.ok(failures.includes('platform/edge.mjs is not a regular file'));
});

test('a malformed or re-pointed lock fails', (t) => {
  const { copy } = consumer(t);
  const lockPath = join(copy, 'platform', LOCK_FILE);
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const variants = [
    [{ ...lock, commit: 'main' }, /commit must be a full 40-character baseline SHA/],
    [{ ...lock, source: 'Wizard-Gang/WizardGang' }, /source must be Wizard-Gang\/baseline/],
    [{ ...lock, extra: true }, /must hold exactly schemaVersion, source, commit and files/],
    [{ ...lock, files: {} }, /must pin at least one file/],
    [{ ...lock, files: { ...lock.files, '../escape.mjs': 'b'.repeat(64) } }, /pins an unsafe path: \.\.\/escape\.mjs/],
    [{ ...lock, files: { ...lock.files, 'wg-edge/auth.mjs': 'short' } }, /pin for wg-edge\/auth\.mjs must be a SHA-256/],
  ];
  for (const [variant, pattern] of variants) {
    writeFileSync(lockPath, JSON.stringify(variant));
    assert.ok(verifyVendored(copy).some((failure) => pattern.test(failure)), String(pattern));
  }
  writeFileSync(lockPath, '{ not json');
  assert.deepEqual(verifyVendored(copy), [`platform/${LOCK_FILE} is not valid JSON`]);
});

test('buildLock and compareVendored agree on in-memory files', () => {
  const files = new Map([['a.mjs', 'one'], ['dir/b.json', '{}']]);
  const lock = buildLock(COMMIT, files);
  assert.deepEqual(Object.keys(lock.files), ['a.mjs', 'dir/b.json']);
  assert.deepEqual(compareVendored(lock, files), []);
  assert.deepEqual(compareVendored(lock, new Map([['a.mjs', 'two'], ['dir/b.json', '{}']])), [`platform/a.mjs differs from baseline ${COMMIT}; never edit vendored files`]);
  assert.throws(() => buildLock('HEAD', files), /full 40-character SHA/);
  assert.throws(() => buildLock(COMMIT, new Map([['a/../b', 'x']])), /unsafe vendored path/);
});

test('the CLI checks a wrangler config and reports usage errors with exit 2', (t) => {
  const directory = temp(t, 'baseline-vendor-cli-');
  const lines = { out: [], err: [] };
  const io = { cwd: directory, out: (line) => lines.out.push(line), err: (line) => lines.err.push(line) };
  assert.equal(run(['render', '--worker', 'demo', '--store-id', '0123456789abcdef0123456789abcdef'], io), 0);
  writeFileSync(join(directory, 'wrangler.jsonc'), lines.out.pop());
  assert.equal(run(['wrangler', '--worker', 'demo'], io), 0);
  assert.match(lines.out.pop(), /wrangler\.jsonc conforms for Worker demo/);
  assert.equal(run(['wrangler', '--worker', 'sharktank', 'wrangler.jsonc'], io), 1);
  assert.ok(lines.err.some((line) => /^FAIL name must equal the Worker label "sharktank"/.test(line)));
  assert.equal(run(['wrangler', '--worker', 'demo', 'missing.jsonc'], io), 1);
  assert.equal(run(['render', '--worker', 'demo', '--store-id', 'nope'], io), 1);
  for (const argv of [[], ['deploy'], ['wrangler'], ['wrangler', '--worker'], ['pin', 'extra'], ['wrangler', '--worker', 'demo', '--force']]) {
    assert.equal(run(argv, io), 2, JSON.stringify(argv));
  }
});

test('the conformance modules are dependency-free, declared and reviewable', async () => {
  const directory = join(platform, 'conformance');
  const { readdirSync } = await import('node:fs');
  const names = readdirSync(directory);
  const declared = new Set([...readFileSync(join(directory, 'index.d.ts'), 'utf8').matchAll(/^export (?:function|const) ([A-Za-z_][A-Za-z0-9_]*)/gm)].map((match) => match[1]));
  const exported = new Set();
  for (const name of names) {
    const source = readFileSync(join(directory, name), 'utf8');
    assert.ok(source.split('\n').length <= 250, `${name} exceeds 250 lines`);
    if (!name.endsWith('.mjs')) continue;
    for (const [, specifier] of source.matchAll(/^import [^;]*? from '([^']+)';$/gm)) {
      assert.match(specifier, /^(?:\.\/[a-z-]+\.mjs|node:[a-z_/]+)$/, `${name} imports ${specifier}`);
    }
    assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gm, ''), /\brequire\(|\bimport\(|\bfetch\(/, `${name} must not load modules or reach the network`);
    for (const key of Object.keys(await import(join(directory, name)))) exported.add(key);
  }
  assert.deepEqual([...declared].sort(), [...exported].sort());
});
