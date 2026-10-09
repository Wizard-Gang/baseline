import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  callerReproduction, checkRelease, checkReproductionJob, checkRun, checkVendorPin, DEPLOY_WORKFLOW, verifyEvidence,
} from '../platform/deploy/evidence.mjs';

const REPOSITORY = 'Wizard-Gang/wizardgang-architecture-demo';
const COMMIT = '497a9288d39550c3a7368de15a0138a70a69b035';
const DEPLOY_SHA = 'd'.repeat(40);
const TAG = 'v0.32.0';
const RUN_ID = '37790745852';
const expected = { repository: REPOSITORY, runId: RUN_ID, attempt: '1', tag: TAG, commit: COMMIT };

// The shape of the demo's Release workflow: the reproduce job runs npm ci and npm run check in one block.
const CALLER = `name: Release
on:
  workflow_dispatch:
permissions:
  contents: write
  actions: read
jobs:
  reproduce:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version-file: .node-version
      - name: Install locked dependencies
        run: npm ci
      - name: Reproduce the tagged state
        run: |
          export WG_LOCAL_D1_PERSIST_TO="$(mktemp -d)"
          npm run check
  deploy:
    needs: reproduce
    uses: ${DEPLOY_WORKFLOW}@${DEPLOY_SHA}
    with:
      worker: demo
    secrets: inherit
`;
// WizardGang's shape: a named verify job, a flow-list needs and a pull-request-aware checkout ref.
const NAMED = `on:
  push:
jobs:
  verify:
    name: verify
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          ref: \${{ github.event.pull_request.head.sha || github.sha }}
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
        with:
          node-version-file: .node-version
      - name: Install
        run: npm ci
      - name: Check exact revision
        run: npm run check
  release-tag:
    needs: verify
    runs-on: ubuntu-latest
    steps:
      - run: echo tag
  deploy-production:
    name: deploy-production
    needs: [verify, release-tag]
    uses: ${DEPLOY_WORKFLOW}@${DEPLOY_SHA}
`;

// The run, attempt jobs and Release as the Actions API reported them for demo Release run 37790745852.
const run = (fields = {}) => ({
  id: Number(RUN_ID), name: 'Release', path: '.github/workflows/release.yml', event: 'workflow_dispatch', head_branch: TAG,
  head_sha: COMMIT, status: 'in_progress', run_attempt: 1, repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY },
  referenced_workflows: [{ path: `${DEPLOY_WORKFLOW}@${DEPLOY_SHA}`, sha: DEPLOY_SHA, ref: undefined }],
  ...fields,
});
const job = (fields = {}) => ({ name: 'reproduce', status: 'completed', conclusion: 'success', head_sha: COMMIT, run_attempt: 1, ...fields });
const jobs = (list = [job(), { name: 'deploy / verify', status: 'in_progress', conclusion: null, head_sha: COMMIT, run_attempt: 1 }]) => ({ total_count: list.length, jobs: list });
const release = (fields = {}) => ({ tag_name: TAG, draft: false, prerelease: false, published_at: '2026-10-08T14:20:00Z', ...fields });
const lock = (commit = DEPLOY_SHA) => JSON.stringify({ schemaVersion: 1, source: 'Wizard-Gang/baseline', commit, files: {} });

test('the caller workflow at the tag names one reproduction job that its deploy-worker call needs', () => {
  assert.deepEqual(callerReproduction(CALLER, DEPLOY_SHA), { job: 'reproduce', failures: [] });
  assert.deepEqual(callerReproduction(NAMED, DEPLOY_SHA), { job: 'verify', failures: [] });
  const fails = (source, pattern, sha = DEPLOY_SHA) => assert.match(callerReproduction(source, sha).failures.join('\n'), pattern);
  fails(CALLER, /from exactly one job; found 0/, 'e'.repeat(40));
  fails(CALLER.replace(`@${DEPLOY_SHA}`, '@main'), /found 0/);
  fails(CALLER.replace('    needs: reproduce\n', ''), /need exactly one job that runs npm ci and then npm run check; found 0/);
  fails(CALLER.replace('          npm run check\n', '          npm test\n'), /found 0/);
  fails(CALLER.replace('        run: npm ci\n', '        run: npm install\n'), /found 0/);
  fails(CALLER.replace('        run: npm ci\n      - name: Reproduce the tagged state\n        run: |\n          export WG_LOCAL_D1_PERSIST_TO="$(mktemp -d)"\n          npm run check\n',
    '        run: npm run check\n      - run: npm ci\n'), /found 0/);
  fails(CALLER.replace('          node-version-file: .node-version\n', '          node-version: 26\n'), /set up Node from \.node-version/);
  fails(CALLER.replace('      - name: Reproduce the tagged state\n', '      - name: Reproduce the tagged state\n        continue-on-error: true\n'), /must not continue on error/);
  fails(CALLER.replace('      - name: Reproduce the tagged state\n', '      - name: Reproduce the tagged state\n        if: false\n'), /must not skip a step/);
  fails(CALLER.replace('          fetch-depth: 0\n', '          ref: refs/heads/main\n'), /check out the run's own commit/);
  fails(NAMED.replace('    name: verify\n', '    name: verify ${{ github.run_id }}\n'), /literal name/);
  // Two candidate reproductions are ambiguous, and a second call is a second deploy.
  fails(NAMED.replace('    needs: verify\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo tag\n',
    '    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: npm run check\n'), /found 2/);
  fails(`${CALLER}  again:\n    needs: reproduce\n    uses: ${DEPLOY_WORKFLOW}@${DEPLOY_SHA}\n`, /from exactly one job; found 2/);
});

test('a reproduction job needed through another job counts, as in SharkTank\'s release', () => {
  const chained = CALLER.replace('  deploy:\n    needs: reproduce\n', '  publish-release:\n    needs: reproduce\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo publish\n  deploy:\n    needs: publish-release\n');
  assert.deepEqual(callerReproduction(chained, DEPLOY_SHA), { job: 'reproduce', failures: [] });
  // A job outside the deploy job's needs is not a reproduction of what deploys.
  const unrelated = chained.replace('  publish-release:\n    needs: reproduce\n', '  publish-release:\n');
  assert.match(callerReproduction(unrelated, DEPLOY_SHA).failures.join(), /found 0/);
});

test('the current run must be the caller\'s own, at the tag commit, in this attempt, with one pinned deploy-worker call', () => {
  assert.deepEqual(checkRun(run(), expected), { failures: [], deploySha: DEPLOY_SHA, path: '.github/workflows/release.yml' });
  assert.deepEqual(checkRun(run({ event: 'push', head_branch: 'main' }), expected).failures, []);
  const failing = [
    [{ id: 1 }, /run evidence is for run 1/],
    [{ run_attempt: 2 }, /attempt 2, not 1/],
    [{ repository: { full_name: 'Wizard-Gang/SharkTank' } }, /belongs to "Wizard-Gang\/SharkTank"/],
    [{ head_repository: { full_name: 'someone/fork' } }, /head repository is not the caller repository/],
    [{ head_sha: 'b'.repeat(40) }, /run head "b+" is not/],
    [{ head_branch: 'feature' }, /neither v0\.32\.0 nor main/],
    [{ event: 'pull_request' }, /not push or workflow_dispatch/],
    [{ event: 'workflow_run' }, /not push or workflow_dispatch/],
    [{ path: 'Wizard-Gang/other/.github/workflows/x.yml@main' }, /not a repository workflow/],
    [{ referenced_workflows: [] }, /exactly once; found 0/],
    [{ referenced_workflows: [{ path: `${DEPLOY_WORKFLOW}@main`, sha: DEPLOY_SHA }] }, /pinned to a full commit/],
    [{ referenced_workflows: [{ path: `${DEPLOY_WORKFLOW}@${DEPLOY_SHA}`, sha: DEPLOY_SHA }, { path: `${DEPLOY_WORKFLOW}@${'e'.repeat(40)}`, sha: 'e'.repeat(40) }] }, /found 2/],
  ];
  for (const [change, pattern] of failing) assert.match(checkRun(run(change), expected).failures.join('\n'), pattern, JSON.stringify(change));
  assert.match(checkRun(null, expected).failures.join(), /not an object/);
});

test('the reproduction job must have completed successfully at the tag commit in this attempt', () => {
  assert.deepEqual(checkReproductionJob(jobs(), { job: 'reproduce', commit: COMMIT, attempt: '1' }), []);
  const failing = [
    [jobs([job({ conclusion: 'failure' })]), /completed\/failure, not completed\/success/],
    [jobs([job({ status: 'in_progress', conclusion: null })]), /in_progress\/null/],
    [jobs([job({ conclusion: 'skipped' })]), /completed\/skipped/],
    [jobs([job({ head_sha: 'b'.repeat(40) })]), /ran at "b+"/],
    [jobs([job({ run_attempt: 2 })]), /ran in attempt 2, not 1/],
    [jobs([]), /exactly one job named "reproduce"; found 0/],
    [jobs([job(), job()]), /found 2/],
    [{ total_count: 101, jobs: [job()] }, /lists 101 jobs; at most 100/],
    [{ message: 'Not Found' }, /not a job list/],
  ];
  for (const [evidence, pattern] of failing) {
    assert.match(checkReproductionJob(evidence, { job: 'reproduce', commit: COMMIT, attempt: '1' }).join('\n'), pattern);
  }
});

test('the tag must have a published Release, and the vendored pin must be the deploy-worker commit', () => {
  assert.deepEqual(checkRelease(release(), TAG), []);
  assert.match(checkRelease(null, TAG).join(), /no published Release for v0\.32\.0/);
  assert.match(checkRelease(release({ draft: true }), TAG).join(), /not published/);
  assert.match(checkRelease(release({ published_at: null }), TAG).join(), /not published/);
  assert.match(checkRelease(release({ tag_name: 'v0.31.2' }), TAG).join(), /names tag "v0\.31\.2"/);
  assert.deepEqual(checkVendorPin(lock(), DEPLOY_SHA), []);
  assert.match(checkVendorPin(lock('5'.repeat(40)), DEPLOY_SHA).join(), /pins "5+", but the run calls deploy-worker\.yml@d+/);
  assert.match(checkVendorPin('{', DEPLOY_SHA).join(), /not readable JSON/);
});

/** A fake GitHub API answering the three reads, recording each request. */
function fakeApi({ runBody = run(), jobsBody = jobs(), releaseBody = release(), status = {} } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const [code, body] = path.endsWith(`/runs/${RUN_ID}`) ? [status.run ?? 200, runBody]
      : path.endsWith('/jobs') ? [status.jobs ?? 200, jobsBody]
        : path.endsWith(`/releases/tags/${TAG}`) ? [status.release ?? (releaseBody ? 200 : 404), releaseBody]
          : [404, { message: 'Not Found' }];
    if (code instanceof Error) throw code;
    return { status: code, text: async () => JSON.stringify(body) };
  };
  return { calls, fetch };
}
const env = { GITHUB_REPOSITORY: REPOSITORY, GITHUB_RUN_ID: RUN_ID, GITHUB_RUN_ATTEMPT: '1', GITHUB_TOKEN: 'ghs_test-token' };
const files = { '.github/workflows/release.yml': CALLER, 'platform/vendor.lock.json': lock() };
const readFile = (path) => {
  if (!Object.hasOwn(files, path)) throw new Error('ENOENT');
  return files[path];
};
const prove = (api, overrides = {}) => verifyEvidence({ tag: TAG, commit: COMMIT, env, root: '', readFile, ...api, ...overrides });

test('the adapter reads only the current run, its attempt jobs and the tag Release, read-only and bounded', async () => {
  const api = fakeApi();
  assert.deepEqual(await prove(api), { failures: [], job: 'reproduce' });
  assert.deepEqual(api.calls.map(({ url }) => url), [
    `https://api.github.com/repos/${REPOSITORY}/actions/runs/${RUN_ID}`,
    `https://api.github.com/repos/${REPOSITORY}/actions/runs/${RUN_ID}/attempts/1/jobs?per_page=100`,
    `https://api.github.com/repos/${REPOSITORY}/releases/tags/${TAG}`,
  ]);
  for (const { init } of api.calls) {
    assert.equal(init.method, undefined);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.headers.authorization, 'Bearer ghs_test-token');
  }
});

test('missing, unreadable or mismatched evidence fails, and no failure echoes a token or a response body', async () => {
  const cases = [
    [{}, { env: { ...env, GITHUB_TOKEN: '' } }, /must identify the current run/],
    [{}, { env: { ...env, GITHUB_RUN_ATTEMPT: undefined } }, /must identify the current run/],
    [{}, { tag: '0.32.0' }, /tag or commit is malformed/],
    [{ status: { run: 403 } }, {}, /current run \(HTTP 403\); the caller job must grant actions: read/],
    [{ status: { run: 404 } }, {}, /run evidence is not an object/],
    [{ status: { run: new Error('getaddrinfo ENOTFOUND') } }, {}, /cannot read the current run: request failed/],
    [{ status: { jobs: 500 } }, {}, /attempt jobs \(HTTP 500\)/],
    [{ runBody: run({ run_attempt: 2 }) }, {}, /attempt 2, not 1/],
    [{ jobsBody: jobs([job({ conclusion: 'failure' })]) }, {}, /completed\/failure/],
    [{ jobsBody: jobs([job({ run_attempt: 2 })]) }, {}, /ran in attempt 2/],
    [{ releaseBody: null }, {}, /no published Release/],
    [{ releaseBody: release({ draft: true }) }, {}, /not published/],
    [{ runBody: run({ referenced_workflows: [{ path: `${DEPLOY_WORKFLOW}@${'e'.repeat(40)}`, sha: 'e'.repeat(40) }] }) }, {}, /vendor\.lock\.json pins "d+", but the run calls deploy-worker\.yml@e+/],
    [{ runBody: run({ path: '.github/workflows/missing.yml' }) }, {}, /cannot read \.github\/workflows\/missing\.yml/],
  ];
  for (const [api, overrides, pattern] of cases) {
    const { failures } = await prove(fakeApi(api), overrides);
    assert.match(failures.join('\n'), pattern, JSON.stringify(api));
    assert.ok(!failures.join('\n').includes('ghs_test-token'));
    assert.ok(!failures.join('\n').includes('Not Found'));
  }
});
