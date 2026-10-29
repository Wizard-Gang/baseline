#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FULL_SHA, RELEASE_TAG, makeSha256Manifest, parseSha256Manifest,
  reconcileReleasePublication, validateReleaseIdentity, verifySha256Manifest,
} from './release-contract.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function gitAt(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function options(argv) {
  const command = argv[0]?.startsWith('--') || !argv.length ? 'identity' : argv.shift();
  const values = { artifact: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) throw new Error(`unexpected argument: ${name}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    const key = name.slice(2);
    if (!['tag', 'commit', 'main-ref', 'manifest', 'artifact', 'write', 'repo', 'signer-workflow'].includes(key)) {
      throw new Error(`unknown option: ${name}`);
    }
    if (key === 'artifact') values.artifact.push(value);
    else if (values[key] !== undefined) throw new Error(`duplicate option: ${name}`);
    else values[key] = value;
  }
  return { command, values };
}

function requireTag(candidate) {
  const tag = candidate || process.env.GITHUB_REF_NAME || '';
  if (!RELEASE_TAG.test(tag)) throw new Error('release tag must be exact stable vMAJOR.MINOR.PATCH');
  return tag;
}

function resolveMainRef(root, explicit) {
  const candidates = explicit ? [explicit] : ['refs/remotes/origin/main', 'refs/heads/main'];
  for (const candidate of candidates) {
    const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status === 0) return candidate;
  }
  if (explicit) throw new Error(`main ref is unavailable: ${explicit}`);
  return null;
}

export function observeReleaseIdentity({ tag, mainRef, root = ROOT } = {}) {
  const exactTag = requireTag(tag);
  const tagRef = `refs/tags/${exactTag}`;
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const lockPath = resolve(root, 'package-lock.json');
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : null;
  const main = resolveMainRef(root, mainRef);
  const headCommit = gitAt(root, 'rev-parse', '--verify', 'HEAD^{commit}');
  let mainIsAncestor = null;
  if (main) {
    const result = spawnSync('git', ['merge-base', '--is-ancestor', headCommit, main], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status === 0) mainIsAncestor = true;
    else if (result.status === 1) mainIsAncestor = false;
    else throw new Error(`unable to verify main reachability from ${main}`);
  }
  return {
    tag: exactTag,
    tagObjectType: gitAt(root, 'cat-file', '-t', tagRef),
    taggedCommit: gitAt(root, 'rev-parse', '--verify', `${tagRef}^{commit}`),
    headCommit,
    mainIsAncestor,
    mainRef: main,
    packageVersion: pkg.version,
    packagePrivate: pkg.private,
    lockfilePresent: lock !== null,
    lockfileVersion: lock?.lockfileVersion,
    lockVersion: lock?.version,
    lockRootVersion: lock?.packages?.['']?.version,
    trackedWorktreeClean: gitAt(root, 'status', '--porcelain=v1', '--untracked-files=no') === '',
    tree: gitAt(root, 'rev-parse', '--verify', `${tagRef}^{tree}`),
    packageBlob: gitAt(root, 'rev-parse', '--verify', `${tagRef}:package.json`),
  };
}

function artifacts(paths) {
  if (!paths.length) throw new Error('at least one --artifact is required');
  return paths.map((path) => ({ name: basename(path), bytes: readFileSync(resolve(path)) }));
}

function runIdentity(values) {
  const observation = observeReleaseIdentity({ tag: values.tag, mainRef: values['main-ref'] });
  const result = validateReleaseIdentity(observation);
  if (!result.ok) throw new Error(result.errors.join('; '));
  if (values['main-ref'] && result.identity.mainReachability !== 'verified') {
    throw new Error(`main reachability was not verified: ${values['main-ref']}`);
  }
  return result.identity;
}

function runManifest(values) {
  const tag = requireTag(values.tag);
  const files = artifacts(values.artifact);
  if (values.write) {
    if (values.manifest) throw new Error('--write and --manifest cannot be combined');
    const text = makeSha256Manifest(files);
    writeFileSync(resolve(values.write), text, { flag: 'w' });
    return { tag, manifest: resolve(values.write), assets: parseSha256Manifest(text) };
  }
  if (!values.manifest) throw new Error('--manifest is required for verification');
  return { tag, ...verifySha256Manifest(readFileSync(resolve(values.manifest), 'utf8'), files) };
}

function runAttestation(values) {
  const tag = requireTag(values.tag);
  if (values.artifact.length !== 1) throw new Error('attestation verification requires exactly one --artifact');
  const commit = values.commit || gitAt(ROOT, 'rev-parse', 'HEAD');
  if (!FULL_SHA.test(commit)) throw new Error('--commit must be an exact lowercase commit SHA');
  const repo = values.repo || process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) throw new Error('--repo owner/name is required');
  const signer = values['signer-workflow'] || `${repo}/.github/workflows/release.yml`;
  const file = resolve(values.artifact[0]);
  const args = ['attestation', 'verify', file, '--repo', repo, '--signer-workflow', signer,
    '--source-ref', `refs/tags/${tag}`, '--source-digest', commit, '--format', 'json'];
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`GitHub attestation verification failed: ${(result.stderr || result.error?.message || 'unknown error').trim()}`);
  }
  let verified;
  try { verified = JSON.parse(result.stdout); } catch { throw new Error('GitHub attestation verification returned malformed JSON'); }
  if (!Array.isArray(verified) || verified.length === 0) throw new Error('GitHub attestation verification returned no matching provenance');
  return { tag, commit, artifact: basename(file), signerWorkflow: signer, verifiedAttestations: verified.length };
}

function runReconcile(values) {
  const tag = requireTag(values.tag);
  const repo = values.repo || process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) throw new Error('--repo owner/name is required');
  const manifest = values.manifest ? readFileSync(resolve(values.manifest)) : null;
  const expectedAssets = manifest ? [
    ...parseSha256Manifest(manifest.toString('utf8')),
    { name: basename(values.manifest), sha256: createHash('sha256').update(manifest).digest('hex') },
  ] : [];
  const result = spawnSync('gh', ['release', 'view', tag, '--repo', repo,
    '--json', 'tagName,isDraft,isPrerelease,assets'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  let existingRelease = null;
  if (result.status === 0) {
    try { existingRelease = JSON.parse(result.stdout); } catch { throw new Error('GitHub release view returned malformed JSON'); }
  } else if (!/release not found|HTTP 404/i.test(result.stderr ?? '')) {
    throw new Error(`GitHub release lookup failed: ${(result.stderr || 'unknown error').trim()}`);
  }
  const decision = reconcileReleasePublication({ tag, expectedAssets, existingRelease });
  if (decision.action === 'reject') throw new Error(decision.errors.join('; '));
  return decision;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { command, values } = options([...argv]);
    const result = command === 'identity' ? runIdentity(values)
      : command === 'manifest' ? runManifest(values)
        : command === 'attestation' ? runAttestation(values)
          : command === 'reconcile' ? runReconcile(values)
            : (() => { throw new Error(`unknown release command: ${command}`); })();
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    console.error(`check-release: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
