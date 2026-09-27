import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { makeSha256Manifest } from '../scripts/release-contract.mjs';
import { parseApiResponse, publishRelease } from '../scripts/publish-release.mjs';

const TAG = 'v1.2.3';
const REPO = 'Wizard-Gang/baseline';
const COMMIT = 'a'.repeat(40);
const TAG_OBJECT = 'b'.repeat(40);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-publish-'));
  try {
    const artifactPath = join(dir, `baseline-${TAG}.tar.gz`);
    const manifestPath = join(dir, 'SHA256SUMS');
    const artifactBytes = Buffer.from('deterministic baseline source archive\n');
    writeFileSync(artifactPath, artifactBytes);
    writeFileSync(manifestPath, makeSha256Manifest([{ name: basename(artifactPath), bytes: artifactBytes }]));
    const args = { tag: TAG, repo: REPO, commit: COMMIT, artifactPath, manifestPath };
    run({ args, artifactBytes, manifestBytes: readFileSync(manifestPath) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function response(status, body) {
  return { status: status < 400 ? 0 : 1, stdout: `HTTP/2.0 ${status} ${status === 200 ? 'OK' : 'Error'}\ncontent-type: application/json\n\n${JSON.stringify(body)}\n`, stderr: status < 400 ? '' : `HTTP ${status}` };
}

function mockGithub({ args, artifactBytes, manifestBytes, release = null, repositoryStatus = 200,
  tagCommit = COMMIT, immutableOnPublish = true, corruptDownload = false,
  failUploadOnce = false, missingVerifyCapability = false } = {}) {
  const history = [];
  const bytes = new Map([[basename(args.artifactPath), artifactBytes], [basename(args.manifestPath), manifestBytes]]);
  let uploadFailed = false;
  let current = release;
  const runner = (argv) => {
    history.push(argv);
    const [group, operation] = argv;
    if (group === 'api') {
      const path = operation;
      if (path === `repos/${REPO}`) return response(repositoryStatus, repositoryStatus === 200 ? { full_name: REPO } : { message: 'denied' });
      if (path === `repos/${REPO}/git/ref/tags/${TAG}`) return response(200, { object: { type: 'tag', sha: TAG_OBJECT } });
      if (path === `repos/${REPO}/git/tags/${TAG_OBJECT}`) return response(200, { tag: TAG, object: { type: 'commit', sha: tagCommit } });
      if (path === `repos/${REPO}/releases/tags/${TAG}`) return current ? response(200, current) : response(404, { message: 'Not Found' });
      throw new Error(`unexpected API path: ${path}`);
    }
    if (group === 'attestation' && operation === 'verify') return { status: 0, stdout: '[{"verificationResult":{}}]' };
    if (group === 'release' && operation === 'create') {
      current = { tag_name: TAG, draft: true, prerelease: false, immutable: false, published_at: null, assets: [] };
      return { status: 0, stdout: '' };
    }
    if (group === 'release' && operation === 'upload') {
      if (failUploadOnce && !uploadFailed) {
        uploadFailed = true;
        return { status: 1, stderr: 'temporary upload failure' };
      }
      const path = argv[3];
      const data = readFileSync(path);
      current.assets.push({ name: basename(path), digest: `sha256:${sha256(data)}` });
      return { status: 0, stdout: '' };
    }
    if (group === 'release' && operation === 'edit') {
      current = { ...current, draft: false, immutable: immutableOnPublish, published_at: '2026-09-24T00:00:00Z' };
      return { status: 0, stdout: '' };
    }
    if (group === 'release' && operation === 'download') {
      const dir = argv[argv.indexOf('--dir') + 1];
      for (const name of [basename(args.artifactPath), basename(args.manifestPath)]) {
        const data = corruptDownload && name === basename(args.artifactPath) ? Buffer.from('tampered') : bytes.get(name);
        writeFileSync(join(dir, name), data);
      }
      return { status: 0, stdout: '' };
    }
    if (group === 'release' && ['verify', 'verify-asset'].includes(operation)) {
      if (missingVerifyCapability && argv.includes('--help')) return { status: 1, stderr: 'unknown command' };
      return { status: 0, stdout: argv.includes('--help') ? 'usage' : '{"verified":true}' };
    }
    throw new Error(`unexpected gh command: ${argv.join(' ')}`);
  };
  return { runner, history, release: () => current };
}

test('GitHub API status is parsed distinctly from CLI exit status', () => {
  assert.equal(parseApiResponse(response(200, { ok: true })).status, 200);
  assert.equal(parseApiResponse(response(404, { message: 'Not Found' })).status, 404);
  assert.throws(() => parseApiResponse({ status: 1, stdout: '', stderr: 'auth failed' }), /lacked an HTTP status/);
});

test('new release is drafted, assets uploaded, verified, published immutably, and downloaded', () => {
  fixture(({ args, artifactBytes, manifestBytes }) => {
    const github = mockGithub({ args, artifactBytes, manifestBytes });
    const result = publishRelease({ ...args, runGh: github.runner });
    assert.equal(result.action, 'create');
    assert.equal(result.immutable, true);
    assert.equal(result.attestations.release, 'verified');
    assert.equal(result.attestations.assets, 'verified');
    assert.equal(github.release().assets.length, 2);
    const operations = github.history.filter((argv) => argv[0] === 'release').map((argv) => argv[1]);
    assert.deepEqual(operations.filter((item) => ['create', 'upload', 'edit', 'download'].includes(item)),
      ['create', 'upload', 'upload', 'edit', 'download']);
    assert.ok(github.history.some((argv) => argv[0] === 'attestation' && argv.includes(`refs/tags/${TAG}`) && argv.includes(COMMIT)));
    assert.ok(github.history.some((argv) => argv[1] === 'create' && argv.includes('--draft') && argv.includes('--verify-tag')));
    assert.ok(github.history.every((argv) => !argv.includes('--clobber')));
  });
});

test('retry resumes only a matching draft and a complete published release is a no-op', () => {
  fixture(({ args, artifactBytes, manifestBytes }) => {
    const partial = { tag_name: TAG, draft: true, prerelease: false, immutable: false, published_at: null,
      assets: [{ name: basename(args.artifactPath), digest: `sha256:${sha256(artifactBytes)}` }] };
    const github = mockGithub({ args, artifactBytes, manifestBytes, release: partial });
    const resumed = publishRelease({ ...args, runGh: github.runner });
    assert.equal(resumed.action, 'upload-missing');
    assert.equal(github.history.filter((argv) => argv[1] === 'upload').length, 1);
    assert.equal(github.history.filter((argv) => argv[1] === 'create').length, 0);
    const next = mockGithub({ args, artifactBytes, manifestBytes, release: github.release() });
    const noop = publishRelease({ ...args, runGh: next.runner });
    assert.equal(noop.action, 'noop');
    assert.equal(next.history.filter((argv) => ['create', 'upload', 'edit'].includes(argv[1])).length, 0);
  });
});

test('a failed upload leaves a draft that can be resumed without replacing assets', () => {
  fixture(({ args, artifactBytes, manifestBytes }) => {
    const github = mockGithub({ args, artifactBytes, manifestBytes, failUploadOnce: true });
    assert.throws(() => publishRelease({ ...args, runGh: github.runner }), /temporary upload failure/);
    assert.equal(github.release().draft, true);
    const resumed = publishRelease({ ...args, runGh: github.runner });
    assert.equal(resumed.action, 'upload-missing');
    assert.equal(github.release().draft, false);
  });
});

test('published partial releases, draft digest drift, and non-immutable publication fail closed', () => {
  fixture(({ args, artifactBytes, manifestBytes }) => {
    const publishedPartial = { tag_name: TAG, draft: false, prerelease: false, immutable: true,
      published_at: '2026-09-24T00:00:00Z', assets: [] };
    const partial = mockGithub({ args, artifactBytes, manifestBytes, release: publishedPartial });
    assert.throws(() => publishRelease({ ...args, runGh: partial.runner }), /published release is missing assets/);
    assert.equal(partial.history.filter((argv) => ['create', 'upload', 'edit'].includes(argv[1])).length, 0);

    const badDraft = { ...publishedPartial, draft: true, immutable: false, published_at: null,
      assets: [{ name: basename(args.artifactPath), digest: `sha256:${'f'.repeat(64)}` }] };
    assert.throws(() => publishRelease({ ...args, runGh: mockGithub({ args, artifactBytes, manifestBytes, release: badDraft }).runner }), /digest is absent or differs/);

    const unprotected = mockGithub({ args, artifactBytes, manifestBytes, immutableOnPublish: false });
    assert.throws(() => publishRelease({ ...args, runGh: unprotected.runner }), /not protected by GitHub immutable releases/);
  });
});

test('repository authorization, remote tag identity, local manifest, and download bytes are mandatory', () => {
  fixture(({ args, artifactBytes, manifestBytes }) => {
    assert.throws(() => publishRelease({ ...args, runGh: mockGithub({ args, artifactBytes, manifestBytes, repositoryStatus: 403 }).runner }), /HTTP 403/);
    assert.throws(() => publishRelease({ ...args, runGh: mockGithub({ args, artifactBytes, manifestBytes, tagCommit: 'c'.repeat(40) }).runner }), /does not point/);
    assert.throws(() => publishRelease({ ...args, runGh: mockGithub({ args, artifactBytes, manifestBytes, corruptDownload: true }).runner }), /downloaded release asset digest differs/);
    writeFileSync(args.manifestPath, `${'0'.repeat(64)}  ${basename(args.artifactPath)}\n`);
    assert.throws(() => publishRelease({ ...args, runGh: mockGithub({ args, artifactBytes, manifestBytes }).runner }), /SHA256 mismatch/);
  });
});

test('missing release attestation verification capability stops before mutation', () => {
  fixture(({ args, artifactBytes, manifestBytes }) => {
    const github = mockGithub({ args, artifactBytes, manifestBytes, missingVerifyCapability: true });
    assert.throws(() => publishRelease({ ...args, runGh: github.runner }), /required gh release verify capability/);
    assert.equal(github.history.filter((argv) => ['create', 'upload', 'edit'].includes(argv[1])).length, 0);
  });
});
