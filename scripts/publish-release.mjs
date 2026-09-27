#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FULL_SHA, RELEASE_TAG, parseSha256Manifest,
  reconcileReleasePublication, verifySha256Manifest,
} from './release-contract.mjs';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function command(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function successful(runGh, args, label) {
  const result = runGh(args);
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.error?.message || 'unknown GitHub CLI error').trim()}`);
  }
  return result.stdout;
}

// gh api --include exposes the HTTP status. A release 404 is meaningful only
// after an authenticated repository lookup has succeeded.
export function parseApiResponse(result) {
  if (result.error) throw new Error(`GitHub API request failed: ${result.error.message}`);
  const output = result.stdout ?? '';
  const lines = [...output.matchAll(/^HTTP\/\d+(?:\.\d+)?\s+(\d{3})[^\r\n]*$/gm)];
  if (!lines.length) throw new Error(`GitHub API response lacked an HTTP status: ${(result.stderr || '').trim()}`);
  const last = lines.at(-1);
  const status = Number(last[1]);
  const headerEnd = output.indexOf('\r\n\r\n', last.index) >= 0
    ? output.indexOf('\r\n\r\n', last.index) + 4
    : output.indexOf('\n\n', last.index) >= 0 ? output.indexOf('\n\n', last.index) + 2 : -1;
  if (headerEnd < 0) throw new Error('GitHub API response lacked a header/body separator');
  const bodyText = output.slice(headerEnd).trim();
  let body = null;
  if (bodyText) {
    try { body = JSON.parse(bodyText); }
    catch { throw new Error(`GitHub API returned malformed JSON (HTTP ${status})`); }
  }
  return { status, body };
}

function api(runGh, path, allowed = [200]) {
  const result = runGh(['api', path, '--include']);
  const response = parseApiResponse(result);
  if (!allowed.includes(response.status)) {
    throw new Error(`GitHub API ${path} returned HTTP ${response.status}: ${response.body?.message ?? 'unexpected response'}`);
  }
  if (response.status < 400 && result.status !== 0) {
    throw new Error(`GitHub API ${path} failed after HTTP ${response.status}: ${(result.stderr || 'unknown error').trim()}`);
  }
  return response;
}

function remoteRelease(runGh, repo, tag) {
  // This call distinguishes an absent release from an inaccessible repository.
  api(runGh, `repos/${repo}`);
  const response = api(runGh, `repos/${repo}/releases/tags/${tag}`, [200, 404]);
  if (response.status === 404) return null;
  const value = response.body;
  if (!value || typeof value !== 'object') throw new Error('GitHub release response is missing');
  return {
    tagName: value.tag_name,
    isDraft: value.draft,
    isPrerelease: value.prerelease,
    isImmutable: value.immutable,
    publishedAt: value.published_at,
    assets: value.assets,
  };
}

function verifyRemoteTag(runGh, repo, tag, commit) {
  const ref = api(runGh, `repos/${repo}/git/ref/tags/${tag}`).body;
  if (ref?.object?.type !== 'tag' || !FULL_SHA.test(ref.object.sha ?? '')) {
    throw new Error(`remote release tag ${tag} is missing or not annotated`);
  }
  const annotated = api(runGh, `repos/${repo}/git/tags/${ref.object.sha}`).body;
  if (annotated?.tag !== tag || annotated?.object?.type !== 'commit' || annotated?.object?.sha !== commit) {
    throw new Error(`remote annotated tag ${tag} does not point to expected commit ${commit}`);
  }
}

function verifyBuildAttestation(runGh, { artifactPath, tag, commit, repo }) {
  const signer = `${repo}/.github/workflows/release.yml`;
  const stdout = successful(runGh, ['attestation', 'verify', artifactPath, '--repo', repo,
    '--signer-workflow', signer, '--source-ref', `refs/tags/${tag}`,
    '--source-digest', commit, '--format', 'json'], 'build provenance verification');
  let verified;
  try { verified = JSON.parse(stdout); } catch { throw new Error('build provenance verifier returned malformed JSON'); }
  if (!Array.isArray(verified) || verified.length === 0) throw new Error('build provenance verifier found no matching attestation');
}

function preflightReleaseVerification(runGh) {
  for (const name of ['verify', 'verify-asset']) {
    successful(runGh, ['release', name, '--help'], `required gh release ${name} capability`);
  }
}

function verifyReleaseAttestations(runGh, { tag, repo, downloaded }) {
  successful(runGh, ['release', 'verify', tag, '--repo', repo, '--format', 'json'], 'GitHub release attestation verification');
  for (const path of downloaded) {
    successful(runGh, ['release', 'verify-asset', tag, path, '--repo', repo, '--format', 'json'],
      `GitHub release asset attestation verification for ${basename(path)}`);
  }
  return { release: 'verified', assets: 'verified' };
}

function expectedFiles({ artifactPath, manifestPath }) {
  const artifactName = basename(artifactPath);
  const manifestName = basename(manifestPath);
  if (!SAFE_NAME.test(artifactName) || !SAFE_NAME.test(manifestName) || artifactName === manifestName) {
    throw new Error('release asset and manifest must have distinct safe basenames');
  }
  const artifactBytes = readFileSync(artifactPath);
  const manifestBytes = readFileSync(manifestPath);
  const entries = parseSha256Manifest(manifestBytes.toString('utf8'));
  if (entries.length !== 1 || entries[0].name !== artifactName) {
    throw new Error('SHA256SUMS must list exactly the requested release artifact');
  }
  verifySha256Manifest(manifestBytes.toString('utf8'), [{ name: artifactName, bytes: artifactBytes }]);
  const expectedAssets = [
    { name: artifactName, sha256: sha256(artifactBytes) },
    { name: manifestName, sha256: sha256(manifestBytes) },
  ];
  return { expectedAssets, paths: new Map([[artifactName, artifactPath], [manifestName, manifestPath]]) };
}

function decide({ tag, expectedAssets, release }) {
  const decision = reconcileReleasePublication({ tag, expectedAssets, existingRelease: release });
  if (decision.action === 'reject') throw new Error(`release state drift: ${decision.errors.join('; ')}`);
  return decision;
}

function verifyPublishedRelease(release, tag, expectedAssets) {
  if (!release) throw new Error(`published release ${tag} is missing`);
  const decision = decide({ tag, expectedAssets, release });
  if (decision.action !== 'noop') throw new Error(`release ${tag} is not fully published`);
  if (release.isImmutable !== true) throw new Error(`published release ${tag} is not protected by GitHub immutable releases`);
  if (!release.publishedAt) throw new Error(`published release ${tag} has no publication timestamp`);
}

function downloadAndVerify(runGh, { tag, repo, expectedAssets, localPaths }) {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-release-verify-'));
  try {
    const args = ['release', 'download', tag, '--repo', repo, '--dir', dir];
    for (const asset of expectedAssets) args.push('--pattern', asset.name);
    successful(runGh, args, 'release asset download');
    const downloaded = [];
    for (const asset of expectedAssets) {
      const path = join(dir, asset.name);
      if (!existsSync(path)) throw new Error(`published release is missing downloaded asset ${asset.name}`);
      if (sha256(readFileSync(path)) !== asset.sha256) throw new Error(`downloaded release asset digest differs: ${asset.name}`);
      if (sha256(readFileSync(path)) !== sha256(readFileSync(localPaths.get(asset.name)))) {
        throw new Error(`downloaded release asset differs from local validated source: ${asset.name}`);
      }
      downloaded.push(path);
    }
    const manifestName = expectedAssets[1].name;
    const artifactName = expectedAssets[0].name;
    verifySha256Manifest(readFileSync(join(dir, manifestName), 'utf8'), [
      { name: artifactName, bytes: readFileSync(join(dir, artifactName)) },
    ]);
    return verifyReleaseAttestations(runGh, { tag, repo, downloaded });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function publishRelease({ tag, repo, artifactPath, manifestPath, commit, runGh = command }) {
  if (!RELEASE_TAG.test(tag ?? '')) throw new Error('release tag must be stable vMAJOR.MINOR.PATCH');
  if (!REPO.test(repo ?? '')) throw new Error('repository must be owner/name');
  if (!FULL_SHA.test(commit ?? '')) throw new Error('commit must be an exact lowercase SHA');
  if (!artifactPath || !manifestPath) throw new Error('artifact and manifest paths are required');
  const artifact = resolve(artifactPath);
  const manifest = resolve(manifestPath);
  const { expectedAssets, paths } = expectedFiles({ artifactPath: artifact, manifestPath: manifest });

  verifyRemoteTag(runGh, repo, tag, commit);
  verifyBuildAttestation(runGh, { artifactPath: artifact, tag, commit, repo });
  preflightReleaseVerification(runGh);

  let release = remoteRelease(runGh, repo, tag);
  let decision = decide({ tag, expectedAssets, release });
  const initialAction = decision.action;
  if (decision.action === 'create') {
    successful(runGh, ['release', 'create', tag, '--repo', repo, '--draft', '--verify-tag',
      '--generate-notes', '--title', tag], 'draft release creation');
    release = remoteRelease(runGh, repo, tag);
    if (!release?.isDraft) throw new Error('new release was not created as a draft');
    decision = decide({ tag, expectedAssets, release });
  }
  if (decision.action === 'upload-missing') {
    for (const name of decision.missingAssets) {
      successful(runGh, ['release', 'upload', tag, paths.get(name), '--repo', repo], `release asset upload for ${name}`);
    }
    release = remoteRelease(runGh, repo, tag);
    decision = decide({ tag, expectedAssets, release });
  }
  if (decision.action === 'publish') {
    // Independently re-read and verify every draft asset before publication.
    release = remoteRelease(runGh, repo, tag);
    if (decide({ tag, expectedAssets, release }).action !== 'publish') {
      throw new Error('draft changed before publication');
    }
    verifyRemoteTag(runGh, repo, tag, commit);
    successful(runGh, ['release', 'edit', tag, '--repo', repo, '--draft=false', '--verify-tag'],
      'draft release publication');
  } else if (decision.action !== 'noop') {
    throw new Error(`release did not reach a publishable state: ${decision.action}`);
  }

  release = remoteRelease(runGh, repo, tag);
  verifyPublishedRelease(release, tag, expectedAssets);
  verifyRemoteTag(runGh, repo, tag, commit);
  const attestations = downloadAndVerify(runGh, { tag, repo, expectedAssets, localPaths: paths });
  return { tag, commit, repo, action: initialAction, immutable: true, assets: expectedAssets, attestations };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--tag', '--repo', '--artifact', '--manifest', '--commit'].includes(key)) throw new Error(`unknown option: ${key}`);
    if (values[key]) throw new Error(`duplicate option: ${key}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    values[key] = value;
  }
  return {
    tag: values['--tag'] || process.env.GITHUB_REF_NAME,
    repo: values['--repo'] || process.env.GITHUB_REPOSITORY,
    artifactPath: values['--artifact'],
    manifestPath: values['--manifest'],
    commit: values['--commit'] || process.env.GITHUB_SHA,
  };
}

export function main(argv = process.argv.slice(2)) {
  try {
    console.log(JSON.stringify(publishRelease(parseArgs(argv))));
    return 0;
  } catch (error) {
    console.error(`publish-release: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
