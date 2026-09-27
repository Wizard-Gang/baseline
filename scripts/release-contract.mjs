import { createHash } from 'node:crypto';
import { basename } from 'node:path';

export const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
export const FULL_SHA = /^[0-9a-f]{40}$/;
export const SHA256 = /^[0-9a-f]{64}$/;

export function validateReleaseIdentity(observation) {
  const errors = [];
  const {
    tag, tagObjectType, taggedCommit, headCommit, mainIsAncestor,
    packageVersion, lockfilePresent, lockfileVersion, lockVersion, lockRootVersion, packagePrivate,
    trackedWorktreeClean, tree, packageBlob,
  } = observation;

  if (!RELEASE_TAG.test(tag ?? '')) errors.push('release tag must be exact stable vMAJOR.MINOR.PATCH without leading zeros');
  if (tagObjectType !== 'tag') errors.push('release tag must be annotated');
  if (!FULL_SHA.test(taggedCommit ?? '')) errors.push('tag must resolve to an exact commit SHA');
  if (!FULL_SHA.test(headCommit ?? '')) errors.push('HEAD must resolve to an exact commit SHA');
  if (taggedCommit !== headCommit) errors.push('tagged commit must equal checked-out HEAD');
  if (mainIsAncestor === false) errors.push('tagged commit must be reachable from main');
  if (packageVersion !== tag?.slice(1)) errors.push('package.json version must match release tag');
  if (packagePrivate !== true) errors.push('source-only release package must remain private');
  if (lockfilePresent !== true) errors.push('package-lock.json is required as version and dependency authority');
  if (!Number.isInteger(lockfileVersion) || lockfileVersion < 3) errors.push('package-lock.json must use a current lockfile format');
  if (lockVersion !== packageVersion) errors.push('package-lock.json version must match package.json');
  if (lockRootVersion !== packageVersion) errors.push('package-lock.json root version must match package.json');
  if (trackedWorktreeClean !== true) errors.push('tracked worktree and index must match tagged HEAD');
  if (!FULL_SHA.test(tree ?? '')) errors.push('release tree must have an exact SHA');
  if (!FULL_SHA.test(packageBlob ?? '')) errors.push('package.json blob must have an exact SHA');

  return {
    ok: errors.length === 0,
    errors,
    identity: errors.length ? null : {
      schema: 'baseline-release-identity/v1',
      tag,
      version: packageVersion,
      commit: taggedCommit,
      tree,
      packageBlob,
      mainReachability: mainIsAncestor === true ? 'verified' : 'unavailable',
    },
  };
}

function assetName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name === basename(name)
    && name !== '.'
    && name !== '..'
    && !name.includes('\\')
    && !/[\r\n\0]/.test(name);
}

export function parseSha256Manifest(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('SHA256 manifest is empty');
  const entries = [];
  const seen = new Set();
  for (const line of text.replace(/\n$/, '').split('\n')) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match || !assetName(match[2])) throw new Error(`malformed SHA256 manifest entry: ${line}`);
    const [, sha256, name] = match;
    if (seen.has(name)) throw new Error(`duplicate SHA256 manifest asset: ${name}`);
    seen.add(name);
    entries.push({ name, sha256 });
  }
  return entries;
}

export function makeSha256Manifest(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error('at least one artifact is required');
  const names = new Set();
  const entries = artifacts.map(({ name, bytes }) => {
    if (!assetName(name)) throw new Error(`invalid artifact name: ${name}`);
    if (names.has(name)) throw new Error(`duplicate artifact name: ${name}`);
    names.add(name);
    if (!Buffer.isBuffer(bytes)) throw new Error(`artifact bytes are required: ${name}`);
    return { name, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  return `${entries.sort((a, b) => a.name.localeCompare(b.name)).map(({ name, sha256 }) => `${sha256}  ${name}`).join('\n')}\n`;
}

export function verifySha256Manifest(manifestText, artifacts) {
  const entries = parseSha256Manifest(manifestText);
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error('at least one artifact is required');
  const actual = new Map();
  for (const { name, bytes } of artifacts) {
    if (!assetName(name) || actual.has(name)) throw new Error(`invalid or duplicate artifact name: ${name}`);
    if (!Buffer.isBuffer(bytes)) throw new Error(`artifact bytes are required: ${name}`);
    actual.set(name, createHash('sha256').update(bytes).digest('hex'));
  }
  if (entries.length !== actual.size) throw new Error('manifest asset set does not match supplied artifacts');
  for (const { name, sha256 } of entries) {
    if (!actual.has(name)) throw new Error(`manifest contains an unsupplied asset: ${name}`);
    if (actual.get(name) !== sha256) throw new Error(`SHA256 mismatch for ${name}`);
  }
  return { ok: true, assets: entries };
}

// Drafts may be resumed after an interrupted publication. Published releases
// are never edited to hide conflicting identity or incomplete assets.
export function reconcileReleasePublication({ tag, expectedAssets = [], existingRelease = null }) {
  if (!RELEASE_TAG.test(tag ?? '')) return { action: 'reject', errors: ['invalid release tag'] };
  const expected = new Map();
  for (const asset of expectedAssets) {
    if (!assetName(asset?.name) || !SHA256.test(asset?.sha256 ?? '') || expected.has(asset.name)) {
      return { action: 'reject', errors: ['invalid or duplicate expected release asset'] };
    }
    expected.set(asset.name, asset.sha256);
  }
  if (existingRelease === null) return { action: 'create', missingAssets: [...expected.keys()], errors: [] };

  const errors = [];
  if (existingRelease.tagName !== tag) errors.push('existing release tag differs from requested tag');
  if (typeof existingRelease.isDraft !== 'boolean') errors.push('existing release draft state is unknown');
  if (existingRelease.isPrerelease !== false) errors.push('existing release is a prerelease or has unknown prerelease state');
  if (!Array.isArray(existingRelease.assets)) errors.push('existing release assets are unavailable');
  if (errors.length) return { action: 'reject', errors };

  const observed = new Map();
  for (const asset of existingRelease.assets) {
    if (!assetName(asset?.name) || observed.has(asset.name)) errors.push('existing release has invalid or duplicate asset names');
    else observed.set(asset.name, asset);
  }
  for (const [name, asset] of observed) {
    if (!expected.has(name)) errors.push(`unexpected release asset: ${name}`);
    else if (asset.digest !== `sha256:${expected.get(name)}`) {
      errors.push(`release asset digest is absent or differs from manifest: ${name}`);
    }
  }
  if (errors.length) return { action: 'reject', errors };
  const missingAssets = [...expected.keys()].filter((name) => !observed.has(name));
  if (missingAssets.length && !existingRelease.isDraft) {
    return { action: 'reject', errors: [`published release is missing assets: ${missingAssets.join(', ')}`] };
  }
  if (missingAssets.length) return { action: 'upload-missing', missingAssets, publishAfterUpload: true, errors: [] };
  if (existingRelease.isDraft) return { action: 'publish', missingAssets: [], errors: [] };
  return { action: 'noop', missingAssets: [], errors: [] };
}
