import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateRepositoryAt, validateRepositoryContract } from '../scripts/repository-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const specimen = () => ({
  ci: read('.github/workflows/ci.yml'),
  release: read('.github/workflows/release.yml'),
  cutter: read('.github/workflows/release-cutter.yml'),
  pkg: JSON.parse(read('package.json')),
  lock: JSON.parse(read('package-lock.json')),
  phase: JSON.parse(read('config/phase.json')),
  provider: JSON.parse(read('config/github-repository-settings.json')),
});

test('the committed repository has only contract-phase content and guarded workflows', () => {
  assert.deepEqual(validateRepositoryAt(root), []);
});

test('PR metadata edits must rerun CI against the exact head', () => {
  const input = specimen();
  input.ci = input.ci.replace('reopened, edited, ready_for_review', 'reopened, ready_for_review')
    .replace('github.event.pull_request.head.sha || github.sha', 'github.sha');
  const failures = validateRepositoryContract(input);
  assert.ok(failures.some((failure) => failure.includes('title or body is edited')));
  assert.ok(failures.some((failure) => failure.includes('exact PR head')));
});

test('broader CI token and missing security check fail the provider contract', () => {
  const input = specimen();
  input.ci = input.ci.replace('contents: read', 'contents: write')
    .replace('  security:\n', '  removed-security:\n');
  const failures = validateRepositoryContract(input);
  assert.ok(failures.some((failure) => failure.includes('read-only')));
  assert.ok(failures.some((failure) => failure.includes('required jobs')));
  assert.ok(failures.some((failure) => failure.includes('provider required checks')));
});

test('release publication cannot lose tag identity or attestation', () => {
  const input = specimen();
  input.release = input.release.replace("tags: ['v*']", 'branches: [main]')
    .replace('cancel-in-progress: false', 'cancel-in-progress: true')
    .replace(/uses: actions\/attest@[0-9a-f]{40}/, 'uses: actions/attest@v4');
  const failures = validateRepositoryContract(input);
  assert.ok(failures.some((failure) => failure.includes('tag push trigger')));
  assert.ok(failures.some((failure) => failure.includes('cancel publication')));
  assert.ok(failures.some((failure) => failure.includes('full commit SHA')));
});

test('release cutter rejects a missing current-main gate or exact-tag dispatch', () => {
  const input = specimen();
  input.cutter = input.cutter.replace('git rev-parse origin/main', 'git rev-parse HEAD')
    .replace('--ref "$RELEASE_TAG" -f expected_sha="$EXPECTED_SHA"', '--ref main');
  const failures = validateRepositoryContract(input);
  assert.ok(failures.some((failure) => failure.includes('exact current main')));
  assert.ok(failures.some((failure) => failure.includes('exact tag and commit')));
});

test('release cutter leaves an older same-version tag in place', () => {
  const input = specimen();
  input.cutter = input.cutter.replace('[ "$release_sha" != "$VALIDATED_SHA" ]', '[ "$release_sha" = "$VALIDATED_SHA" ]');
  assert.ok(validateRepositoryContract(input).some((failure) => failure.includes('older same-version tags')));
});

test('workflows cannot call missing scripts, and phase cannot enable application code', () => {
  const input = specimen();
  input.pkg.scripts['audit:dependencies'] = 'echo audit skipped';
  input.release += '\n      - run: npm run nonexistent:gate\n';
  input.phase.applicationDevelopment = true;
  const failures = validateRepositoryContract(input);
  assert.ok(failures.some((failure) => failure.includes('high-severity')));
  assert.ok(failures.some((failure) => failure.includes('nonexistent:gate')));
  assert.ok(failures.some((failure) => failure.includes('application development')));
});
