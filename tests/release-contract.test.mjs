import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  makeSha256Manifest, reconcileReleasePublication, validateReleaseIdentity,
  verifySha256Manifest,
} from '../scripts/release-contract.mjs';
import { observeReleaseIdentity } from '../scripts/check-release.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const DIGEST = 'c'.repeat(64);
const artifact = { name: 'baseline-v1.2.3.tar.gz', bytes: Buffer.from('reproducible release\n') };

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(run, { version = '1.2.3' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'baseline-release-'));
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Release Contract Test');
    git(root, 'config', 'user.email', 'release@example.invalid');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'baseline', private: true, version }) + '\n');
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'baseline', version, lockfileVersion: 3, packages: { '': { name: 'baseline', version } } }) + '\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'initial');
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('exact annotated tag, package, lockfile, clean HEAD, and main ancestry form one identity', () => {
  fixture((root) => {
    git(root, 'tag', '-a', 'v1.2.3', '-m', 'release');
    const observed = observeReleaseIdentity({ root, tag: 'v1.2.3', mainRef: 'refs/heads/main' });
    const result = validateReleaseIdentity(observed);
    assert.equal(result.ok, true, result.errors.join('; '));
    assert.equal(result.identity.commit, git(root, 'rev-parse', 'HEAD'));
    assert.equal(result.identity.mainReachability, 'verified');
    assert.match(result.identity.tree, /^[0-9a-f]{40}$/);
    assert.match(result.identity.packageBlob, /^[0-9a-f]{40}$/);
  });
});

test('malformed and lightweight release tags fail closed', () => {
  fixture((root) => {
    git(root, 'tag', '-a', 'v01.2.3', '-m', 'bad');
    assert.throws(() => observeReleaseIdentity({ root, tag: 'v01.2.3' }), /exact stable/);
    git(root, 'tag', 'v1.2.3');
    const result = validateReleaseIdentity(observeReleaseIdentity({ root, tag: 'v1.2.3' }));
    assert.equal(result.ok, false);
    assert.match(result.errors.join('; '), /annotated/);
  });
});

test('tag, package, lockfile, HEAD, and main drift are rejected', () => {
  fixture((root) => {
    git(root, 'tag', '-a', 'v1.2.3', '-m', 'release');
    writeFileSync(join(root, 'next.txt'), 'next\n');
    git(root, 'add', 'next.txt');
    git(root, 'commit', '-qm', 'descendant');
    const result = validateReleaseIdentity(observeReleaseIdentity({ root, tag: 'v1.2.3' }));
    assert.match(result.errors.join('; '), /tagged commit must equal/);
  });
  fixture((root) => {
    git(root, 'tag', '-a', 'v1.2.4', '-m', 'wrong version');
    const result = validateReleaseIdentity(observeReleaseIdentity({ root, tag: 'v1.2.4' }));
    assert.match(result.errors.join('; '), /package.json version/);
  });
  fixture((root) => {
    git(root, 'checkout', '-qb', 'feature');
    writeFileSync(join(root, 'feature.txt'), 'unmerged\n');
    git(root, 'add', 'feature.txt');
    git(root, 'commit', '-qm', 'unmerged');
    git(root, 'tag', '-a', 'v1.2.3', '-m', 'off-main');
    const result = validateReleaseIdentity(observeReleaseIdentity({ root, tag: 'v1.2.3', mainRef: 'refs/heads/main' }));
    assert.match(result.errors.join('; '), /reachable from main/);
  });
  fixture((root) => {
    git(root, 'tag', '-a', 'v1.2.3', '-m', 'release');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'baseline', private: true, version: '1.2.4' }) + '\n');
    const result = validateReleaseIdentity(observeReleaseIdentity({ root, tag: 'v1.2.3' }));
    assert.match(result.errors.join('; '), /tracked worktree/);
  });
});

test('version and lockfile ownership are both enforced', () => {
  const base = {
    tag: 'v1.2.3', tagObjectType: 'tag', taggedCommit: SHA, headCommit: SHA,
    mainIsAncestor: true, packageVersion: '1.2.3', lockfilePresent: true,
    lockfileVersion: 3, lockVersion: '1.2.3',
    lockRootVersion: '1.2.3', packagePrivate: true, trackedWorktreeClean: true,
    tree: OTHER_SHA, packageBlob: OTHER_SHA,
  };
  assert.equal(validateReleaseIdentity(base).ok, true);
  assert.match(validateReleaseIdentity({ ...base, lockRootVersion: '1.2.2' }).errors.join('; '), /package-lock\.json root/);
  assert.match(validateReleaseIdentity({ ...base, lockfilePresent: false }).errors.join('; '), /package-lock\.json is required/);
  assert.match(validateReleaseIdentity({ ...base, packagePrivate: false }).errors.join('; '), /remain private/);
});

test('SHA256 manifest uses exact asset names and detects changed, missing, and extra assets', () => {
  const manifest = makeSha256Manifest([artifact]);
  assert.match(manifest, /^[0-9a-f]{64}  baseline-v1\.2\.3\.tar\.gz\n$/);
  assert.equal(verifySha256Manifest(manifest, [artifact]).ok, true);
  assert.throws(() => verifySha256Manifest(manifest, [{ ...artifact, bytes: Buffer.from('tampered') }]), /SHA256 mismatch/);
  assert.throws(() => verifySha256Manifest(manifest, [artifact, { name: 'extra', bytes: Buffer.from('x') }]), /asset set/);
  assert.throws(() => verifySha256Manifest(`${manifest}${manifest}`, [artifact]), /duplicate/);
  assert.throws(() => verifySha256Manifest(`${DIGEST}  ..\/escape\n`, [artifact]), /malformed/);
});

test('publication reconciliation creates, resumes drafts, no-ops published releases, and rejects drift', () => {
  const sha256 = createHash('sha256').update(artifact.bytes).digest('hex');
  const expectedAssets = [{ name: artifact.name, sha256 }];
  const base = { tagName: 'v1.2.3', isDraft: true, isPrerelease: false, assets: [] };
  assert.equal(reconcileReleasePublication({ tag: 'v1.2.3', expectedAssets }).action, 'create');
  const missing = reconcileReleasePublication({ tag: 'v1.2.3', expectedAssets, existingRelease: base });
  assert.equal(missing.action, 'upload-missing');
  assert.deepEqual(missing.missingAssets, [artifact.name]);
  assert.equal(missing.publishAfterUpload, true);
  const completeDraft = { ...base, assets: [{ name: artifact.name, digest: `sha256:${sha256}` }] };
  assert.equal(reconcileReleasePublication({ tag: 'v1.2.3', expectedAssets, existingRelease: completeDraft }).action, 'publish');
  const published = { ...completeDraft, isDraft: false };
  assert.equal(reconcileReleasePublication({ tag: 'v1.2.3', expectedAssets, existingRelease: published }).action, 'noop');
  assert.equal(reconcileReleasePublication({ tag: 'v1.2.3', expectedAssets, existingRelease: { ...published, assets: [] } }).action, 'reject');
  for (const changed of [
    { ...published, tagName: 'v1.2.4' },
    { ...published, isDraft: null },
    { ...published, isPrerelease: true },
    { ...published, assets: [{ name: artifact.name, digest: `sha256:${DIGEST}` }] },
    { ...published, assets: [{ name: artifact.name }] },
    { ...published, assets: [...published.assets, { name: 'unexpected', digest: `sha256:${DIGEST}` }] },
  ]) {
    assert.equal(reconcileReleasePublication({ tag: 'v1.2.3', expectedAssets, existingRelease: changed }).action, 'reject');
  }
});

test('attestation CLI binds verifier to repository, workflow, tag ref, and source digest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-gh-'));
  try {
    const artifactPath = join(dir, artifact.name);
    const logPath = join(dir, 'gh-args');
    writeFileSync(artifactPath, artifact.bytes);
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$GH_ARGS_LOG"\nprintf "[{\\"verificationResult\\":{}}]\\n"\n');
    chmodSync(join(dir, 'gh'), 0o755);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-release.mjs', import.meta.url)),
      'attestation', '--tag', 'v1.2.3', '--commit', SHA, '--repo', 'Wizard-Gang/baseline',
      '--signer-workflow', 'Wizard-Gang/baseline/.github/workflows/release.yml', '--artifact', artifactPath], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_ARGS_LOG: logPath },
    });
    assert.equal(result.status, 0, result.stderr);
    const args = readFileSync(logPath, 'utf8').trim().split('\n');
    assert.deepEqual(args.slice(0, 3), ['attestation', 'verify', artifactPath]);
    assert.ok(args.includes('refs/tags/v1.2.3'));
    assert.ok(args.includes(SHA));
    assert.ok(args.includes('Wizard-Gang/baseline/.github/workflows/release.yml'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
