import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FORBIDDEN_APPLICATION_PATHS, PLATFORM_GRANT, validateRepositoryAt, validateRepositoryContract, validateRepositoryPaths,
} from '../scripts/repository-contract.mjs';

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

test('the committed phase grants exactly platform/ for shared edge code', () => {
  const { phase } = specimen();
  assert.equal(phase.applicationDevelopment, false);
  assert.deepEqual(phase.platform, { ...PLATFORM_GRANT });
});

test('a phase without the exact platform grant fails the contract', () => {
  const variants = [
    (phase) => { delete phase.platform; },
    (phase) => { phase.platform.path = 'src/'; },
    (phase) => { phase.platform.purpose = 'product code'; },
    (phase) => { phase.platform.deploy = true; },
    (phase) => { phase.workers = { path: 'workers/' }; },
  ];
  for (const change of variants) {
    const input = specimen();
    change(input.phase);
    assert.ok(validateRepositoryContract(input).some((failure) => failure.includes('phase')), change.toString());
  }
});

test('platform/ is accepted only under the grant and never unlocks application paths', () => {
  const { phase } = specimen();
  const withoutGrant = { ...phase };
  delete withoutGrant.platform;
  assert.deepEqual(validateRepositoryPaths(new Map(), phase), []);
  assert.deepEqual(validateRepositoryPaths(new Map([['platform', true]]), phase), []);
  assert.deepEqual(validateRepositoryPaths(new Map(), withoutGrant), []);
  assert.ok(validateRepositoryPaths(new Map([['platform', true]]), withoutGrant)
    .some((failure) => failure.includes('without the config/phase.json platform grant')));
  assert.ok(validateRepositoryPaths(new Map([['platform', false]]), phase)
    .some((failure) => failure.includes('must be a directory')));
  for (const path of FORBIDDEN_APPLICATION_PATHS) {
    assert.deepEqual(validateRepositoryPaths(new Map([['platform', true], [path, true]]), phase),
      [`application path exists before contract proof: ${path}`]);
  }
});

test('a repository copy passes with an empty platform/ and fails without the grant or with a forbidden path', (t) => {
  const copy = mkdtempSync(join(tmpdir(), 'baseline-contract-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(root, copy, {
    recursive: true,
    filter: (source) => !/^(?:\.git|node_modules)(?:[\\/]|$)/.test(relative(root, source)),
  });
  mkdirSync(join(copy, 'platform'));
  assert.deepEqual(validateRepositoryAt(copy), []);

  mkdirSync(join(copy, 'workers'));
  assert.ok(validateRepositoryAt(copy).includes('application path exists before contract proof: workers'));
  rmSync(join(copy, 'workers'), { recursive: true });

  const phase = JSON.parse(readFileSync(join(copy, 'config/phase.json'), 'utf8'));
  delete phase.platform;
  writeFileSync(join(copy, 'config/phase.json'), `${JSON.stringify(phase, null, 2)}\n`);
  assert.ok(validateRepositoryAt(copy).some((failure) => failure.includes('without the config/phase.json platform grant')));
});

test('a repository copy fails when the Cloudflare desired state drifts from the closed policy', (t) => {
  const copy = mkdtempSync(join(tmpdir(), 'baseline-contract-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(root, copy, {
    recursive: true,
    filter: (source) => !/^(?:\.git|node_modules)(?:[\\/]|$)/.test(relative(root, source)),
  });
  const path = join(copy, 'config/cloudflare.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.kv = ['wg-gateway-status-prod'];
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  assert.ok(validateRepositoryAt(copy).includes('config/cloudflare.json: kv: KV namespaces are not allowed'));

  rmSync(path);
  assert.ok(validateRepositoryAt(copy).includes('missing or empty repository authority: config/cloudflare.json'));
});
