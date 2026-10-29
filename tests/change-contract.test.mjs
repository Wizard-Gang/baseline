import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import {
  CONTROLLED_TYPES, LAST_DIRECT_TASK,
  parseBranch, parsePlanTitle, parseTitle, validateBody, validateHistory, validatePlan, validatePullRequest,
} from '../contract/change-contract.mjs';

const scriptRoot = resolve(import.meta.dirname, '..');
const fixtures = [];

const body = (risk = 'Low') => [
  'Change:', 'Implement the selected contract.', '',
  'Reason:', 'Keep accepted changes traceable.', '',
  'Impact:', 'Repository process only.', '',
  'Risk:', risk, '',
  'Controls:', 'Preserve one controlled commit.', '',
  'Validation:', 'node --test tests/change-contract.test.mjs', '',
  'Evidence:', 'Focused test results.', '',
  'Source:', 'Current main and active task.', '',
  'Release:', 'Unreleased',
].join('\n');

const task = (number, type = 'TEST') => `### BASE-${String(number).padStart(3, '0')} — [${type}] Prove process contract

- Dependency: Previous controlled change.
- Why: The process needs a deterministic guard.
- Scope: Add one process test.
- Non-goals: No application behavior.
- Acceptance: The test catches a regression.
- Validation: node --test tests/change-contract.test.mjs.
- Authorities: contract/change-contract.mjs.
`;

const pad = (number) => String(number).padStart(3, '0');
// Every plan records its highest ID ever used; validateQueueEdit keeps a removed queued ID retired below it.
const planAt = (highest, ...numbers) => `# Implementation plan\n\n## Open tasks\n\n**Highest ID ever used:** BASE-${pad(highest)}.\n\n${numbers.map((n) => task(n)).join('\n')}`;
const plan = (...numbers) => planAt(Math.max(3, ...numbers), ...numbers);
const emptyTemplate = readFileSync(resolve(import.meta.dirname, 'fixtures/empty-plan.md'), 'utf8');
const emptyPlan = (highest = 3) => emptyTemplate.replace('<ID>', `BASE-${pad(highest)}`);

const record = (number, parent = null, type = 'TEST') => ({
  sha: `sha-${number}`,
  parents: parent === null ? [] : [parent],
  subject: `[BASE-${String(number).padStart(3, '0')}] [${type}] Prove process contract`,
  body: body(),
});

function candidate(overrides = {}) {
  const initial = record(1);
  const head = record(2, initial.sha);
  return {
    baseSha: initial.sha,
    targetBranch: 'main',
    mergeBaseSha: initial.sha,
    commitRangeCount: 1,
    baseHistory: [initial],
    head,
    branch: 'base-002-prove-process-contract',
    title: head.subject,
    prBody: head.body,
    basePlan: plan(2, 3),
    headPlan: plan(3),
    ...overrides,
  };
}

test('BASE title and branch use one canonical number and primary type', () => {
  assert.deepEqual(parseTitle('[BASE-001] [INIT] Establish baseline'), {
    id: 'BASE-001', number: 1, type: 'INIT', summary: 'Establish baseline',
  });
  assert.equal(parseTitle('[BASE-001] [FEATURE] Establish baseline'), null);
  assert.equal(parseTitle('[BASE-001] [TEST] [BUILD] Add second type'), null);
  assert.equal(parseTitle('[BASE-0001] [TEST] Padded identity'), null);
  assert.equal(parseBranch('base-001-establish-baseline')?.id, 'BASE-001');
  assert.equal(parseBranch('base-0001-padded'), null);
  assert.equal(parseBranch('feature/base-001-establish'), null);
  assert.deepEqual(parsePlanTitle('[PLAN] Queue the adapter tasks'), { summary: 'Queue the adapter tasks' });
  assert.equal(parsePlanTitle('[PLAN] [FEAT] Queue the adapter tasks'), null);
  assert.equal(parsePlanTitle('[PLAN]Queue'), null);
  assert.ok(CONTROLLED_TYPES.includes('REVERT'));
});

test('controlled body requires ordered, unique, nonempty fields and classified risk', () => {
  assert.deepEqual(validateBody(body(), 'BASE-001'), []);
  assert.match(validateBody(body().replace('Evidence:\nFocused test results.', ''), 'BASE-001').join(' '), /exactly one Evidence:/);
  assert.match(validateBody(`${body()}\nChange:\nDuplicate`, 'BASE-001').join(' '), /exactly one Change:/);
  assert.match(validateBody(body().replace('Controls:\nPreserve one controlled commit.', 'Controls:\n'), 'BASE-001').join(' '), /Controls: has no value/);
  assert.match(validateBody(body().replace('Risk:\nLow', 'Risk:\nUnknown'), 'BASE-001').join(' '), /Risk: must start with/);
  assert.match(validateBody(body().replace('Reason:', 'Temporary:').replace('Impact:', 'Reason:').replace('Temporary:', 'Impact:'), 'BASE-001').join(' '), /out of order/);
});

test('first-parent main history begins at BASE-001 and never reuses an ID', () => {
  const first = record(1);
  const second = record(2, first.sha);
  assert.deepEqual(validateHistory([first, second]).failures, []);
  assert.equal(validateHistory([first, second]).lastId, 2);
  const gap = record(9, first.sha);
  const planned = { ...record(0, gap.sha), sha: 'sha-plan', subject: '[PLAN] Reorder the queue' };
  const back = record(4, planned.sha);
  assert.deepEqual(validateHistory([first, gap, planned, back]).failures, [], 'IDs need not be contiguous or ascending');
  assert.equal(validateHistory([first, gap, planned, back]).lastId, 9);

  assert.match(validateHistory([{ ...first, subject: 'Bootstrap baseline repository' }]).failures.join(' '), /invalid controlled title/);
  assert.match(validateHistory([record(2)]).failures.join(' '), /must begin at BASE-001/);
  assert.match(validateHistory([first, { ...second, subject: first.subject }]).failures.join(' '), /BASE-001 was already used/);
  assert.match(validateHistory([first, { ...planned, parents: [first.sha], body: '' }]).failures.join(' '), /\[PLAN\]: expected exactly one Change:/);
  assert.match(validateHistory([first, { ...second, parents: [first.sha, 'other'] }]).failures.join(' '), /without merge commits/);
  assert.match(validateHistory([first, { ...second, body: '' }]).failures.join(' '), /exactly one Change:/);
});

test('active plan holds unique undelivered tasks in any order and no completed ledger', () => {
  const delivered = new Set([1]);
  assert.match(validatePlan(null, delivered).failures.join(' '), /permanent implementation_plan.md is missing/);
  assert.deepEqual(validatePlan(emptyPlan(), delivered).failures, []);
  assert.deepEqual(validatePlan(plan(2, 3), delivered).failures, []);
  assert.deepEqual(validatePlan(plan(5, 2, 9), delivered).failures, [], 'gaps and reordering are allowed');
  assert.deepEqual(validatePlan(plan(2).replaceAll(/^- /gm, ''), delivered).failures, []);
  assert.match(validatePlan(plan(2, 1), delivered).failures.join(' '), /BASE-001: was already delivered/);
  assert.match(validatePlan(plan(2, 3, 2), delivered).failures.join(' '), /BASE-002: queued more than once/);
  assert.match(validatePlan('# Plan\n\n## Completed\n\n' + task(2), delivered).failures.join(' '), /historical sections/);
  assert.match(validatePlan(plan(2).replace('- Validation: node --test tests/change-contract.test.mjs.', ''), delivered).failures.join(' '), /missing nonempty Validation/);
});

test('task PR binds exact head, branch, a queued or new ID, single commit, and its own retirement', () => {
  assert.deepEqual(validatePullRequest(candidate()).failures, []);
  assert.match(validatePullRequest(candidate({ title: '[BASE-002] [BUILD] Different title' })).failures.join(' '), /exactly equal/);
  assert.match(validatePullRequest(candidate({ prBody: `${body()}\nChanged` })).failures.join(' '), /PR body must exactly equal/);
  assert.deepEqual(validatePullRequest(candidate({ prBody: body().replaceAll('\n', '\r\n') + '\r\n' })).failures, []);
  assert.match(validatePullRequest(candidate({ branch: 'base-003-wrong-id' })).failures.join(' '), /does not match PR/);
  assert.match(validatePullRequest(candidate({ targetBranch: 'develop' })).failures.join(' '), /must target main/);
  assert.match(validatePullRequest(candidate({ commitRangeCount: 2 })).failures.join(' '), /one controlled commit/);
  assert.match(validatePullRequest(candidate({ mergeBaseSha: 'stale-base' })).failures.join(' '), /direct child/);
  assert.match(validatePullRequest(candidate({ headPlan: plan(2, 3) })).failures.join(' '), /BASE-002: a delivery removes its own task/);
  assert.match(validatePullRequest(candidate({ headPlan: null })).failures.join(' '), /head plan: permanent implementation_plan.md is missing/);
  assert.match(validatePullRequest(candidate({ title: '[BASE-002] [FEAT] Prove process contract', head: { ...candidate().head, subject: '[BASE-002] [FEAT] Prove process contract' } })).failures.join(' '), /queued type TEST must match PR type/);
  // A task PR may edit, reorder, remove or add other queued tasks, from any queue state.
  assert.deepEqual(validatePullRequest(candidate({ basePlan: plan(3, 2), headPlan: plan(3) })).failures, [], 'need not be first');
  assert.deepEqual(validatePullRequest(candidate({ basePlan: plan(2, 3, 4), headPlan: plan(4, 5) })).failures, []);
  assert.deepEqual(validatePullRequest(candidate({ basePlan: plan(2), headPlan: emptyPlan() })).failures, []);
  assert.deepEqual(validatePullRequest(candidate({ basePlan: emptyPlan(1), headPlan: emptyPlan(2) })).failures, [], 'a new ID needs no queue entry');
  assert.match(validatePullRequest(candidate({ basePlan: emptyPlan(1), headPlan: emptyPlan(1) })).failures.join(' '), /BASE-002: the head plan must raise its highest ID ever used/);
  assert.match(validatePullRequest(candidate({ basePlan: planAt(5, 2, 3), headPlan: planAt(4, 3) })).failures.join(' '), /must never fall below BASE-005/);
  assert.match(validatePullRequest(candidate({ basePlan: plan(3, 4), headPlan: plan(3, 4) })).failures.join(' '), /BASE-002 is neither queued nor a new ID above BASE-004/);
  assert.match(validatePullRequest(candidate({ headPlan: plan(3, 2) })).failures.join(' '), /delivery removes its own task/);
  assert.match(validatePullRequest(candidate({ headPlan: plan(3, 1) })).failures.join(' '), /head plan: BASE-001: was already delivered/);
  assert.match(validatePullRequest(candidate({ basePlan: plan(2, 5), headPlan: plan(4) })).failures.join(' '), /BASE-004: a new task takes an ID above BASE-005/);
  assert.match(validatePullRequest(candidate({ basePlan: planAt(6, 2), headPlan: planAt(6, 4) })).failures.join(' '), /BASE-004: a new task takes an ID above BASE-006/, 'a removed queued ID stays retired');
  assert.deepEqual(validatePullRequest(candidate({ basePlan: planAt(6, 2), headPlan: planAt(7, 7) })).failures, []);
});

const r001 = (...tasks) => ({ id: 'r001', branch: 'release/r001', tasks });
const planPr = (overrides = {}) => {
  const initial = record(1);
  const head = { ...record(0, initial.sha), sha: 'sha-plan', subject: '[PLAN] Reorder the queue' };
  return validatePullRequest(candidate({
    head, title: head.subject, prBody: head.body, branch: 'plan-reorder-the-queue', targetBranch: 'release/r001',
    basePlan: plan(2, 3), headPlan: plan(3, 2), changedFiles: ['implementation_plan.md'], ...overrides,
  })).failures.join(' ');
};

test('a plan-only PR takes no ID and may add, edit, reorder or remove queued tasks from any queue state', () => {
  assert.equal(planPr(), '');
  assert.equal(planPr({ basePlan: emptyPlan(1), headPlan: plan(2, 3) }), '');
  assert.equal(planPr({ headPlan: emptyPlan() }), '');
  assert.equal(planPr({ headPlan: plan(3, 4, 2) }), '');
  assert.equal(planPr({ headPlan: plan(2, 3).replace('Add one process test.', 'Add two process tests.') }), '');
  assert.match(planPr({ changedFiles: ['implementation_plan.md', 'src/index.ts'] }), /changes only implementation_plan.md/);
  assert.match(planPr({ changedFiles: [] }), /changes only implementation_plan.md/);
  assert.match(planPr({ targetBranch: 'main' }), /plan-only PR must target the open release\/rNNN branch/);
  assert.match(planPr({ branch: 'base-002-reorder' }), /plan-only branch must be plan-imperative-summary/);
  assert.match(planPr({ headPlan: plan(3, 1) }), /BASE-001: was already delivered/);
  assert.equal(planPr({ headPlan: plan(3) }), '', 'removing a task retires it');
  assert.match(planPr({ basePlan: planAt(5, 2, 3), headPlan: planAt(5, 2, 3, 4) }), /BASE-004: a new task takes an ID above BASE-005/);
  assert.match(planPr({ title: '[PLAN] Reorder', prBody: body() }), /exactly equal the head commit subject/);
});
const intoRelease = (overrides = {}) => candidate({
  targetBranch: 'release/r001', baseRelease: null, headRelease: r001('BASE-002'),
  ...overrides,
});

test('a task PR into the open release branch extends config/release.json', () => {
  assert.deepEqual(validatePullRequest(intoRelease()).failures, []);
  assert.deepEqual(validatePullRequest(intoRelease({ baseRelease: r001('BASE-001'), headRelease: r001('BASE-001', 'BASE-002') })).failures, []);
  assert.match(validatePullRequest(intoRelease({ targetBranch: 'release/r002' })).failures.join(' '), /must target the config\/release.json branch release\/r001/);
  assert.match(validatePullRequest(intoRelease({ headRelease: r001('BASE-001', 'BASE-002') })).failures.join(' '), /tasks must be BASE-002/);
  assert.match(validatePullRequest(intoRelease({ headRelease: null })).failures.join(' '), /must be an \{id, branch, tasks\} object/);
  assert.match(validatePullRequest(intoRelease({ headRelease: { ...r001('BASE-002'), id: 'r002' } })).failures.join(' '), /branch must be release\/r002/);
  assert.match(validatePullRequest(intoRelease({ targetBranch: 'release/r1' })).failures.join(' '), /must target main or a release\/rNNN branch/);
});

test(`tasks after BASE-${String(LAST_DIRECT_TASK).padStart(3, "0")} target a release branch, never main`, () => {
  const history = Array.from({ length: LAST_DIRECT_TASK }, (_, index) => record(index + 1, index ? `sha-${index}` : null));
  const head = record(LAST_DIRECT_TASK + 1, history.at(-1).sha);
  const late = {
    baseSha: head.parents[0], mergeBaseSha: head.parents[0], baseHistory: history, head,
    branch: `base-${String(LAST_DIRECT_TASK + 1).padStart(3, '0')}-prove-process-contract`, title: head.subject, prBody: head.body,
    basePlan: plan(LAST_DIRECT_TASK + 1), headPlan: emptyPlan(LAST_DIRECT_TASK + 1),
  };
  assert.match(validatePullRequest(candidate(late)).failures.join(' '), /must target the open release\/rNNN branch/);
  assert.deepEqual(validatePullRequest(intoRelease({ ...late, headRelease: r001(head.subject.slice(1, 9)) })).failures, []);
});

test('a release PR carries exactly one commit per listed task under a derived title', () => {
  const main = record(1);
  const first = record(2, main.sha);
  const second = record(3, first.sha);
  const release = (overrides = {}) => validatePullRequest({
    baseSha: main.sha, mergeBaseSha: main.sha, targetBranch: 'main', branch: 'release/r001',
    title: '[RELEASE] r001: BASE-002..BASE-003', prBody: '', baseHistory: [main], rangeRecords: [first, second],
    commitRangeCount: 2, head: second, headRelease: r001('BASE-002', 'BASE-003'), basePlan: plan(2, 3), headPlan: emptyPlan(),
    ...overrides,
  }).failures.join(' ');
  assert.equal(release(), '');
  assert.match(release({ title: '[RELEASE] r001: BASE-002' }), /title must be \[RELEASE\] r001: BASE-002\.\.BASE-003/);
  assert.match(release({ rangeRecords: [first], commitRangeCount: 1 }), /one per listed task \(BASE-002, BASE-003\); found BASE-002/);
  assert.match(release({ mergeBaseSha: 'stale-base' }), /current with main/);
  assert.match(release({ commitRangeCount: 3 }), /one first-parent chain/);
  assert.match(release({ headPlan: plan(3) }), /head plan: BASE-003: was already delivered/);
  const planned = { ...record(0, first.sha), sha: 'sha-plan', subject: '[PLAN] Queue later work' };
  const after = { ...second, parents: [planned.sha] };
  assert.equal(release({ rangeRecords: [first, planned, after], commitRangeCount: 3, headPlan: plan(5) }), '', 'plan-only commits ride along');
  assert.match(release({ branch: 'release/r002' }), /head must be the config\/release.json branch release\/r001/);
  assert.match(release({ rangeRecords: [first, { ...second, body: '' }] }), /exactly one Change:/);
});


function command(cwd, program, args, env = {}) {
  const childEnv = { ...process.env };
  for (const name of [
    'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'GITHUB_SHA',
    'CHANGE_BASE_SHA', 'CHANGE_HEAD_SHA', 'CHANGE_HEAD_REF',
    'CHANGE_PR_TITLE', 'CHANGE_PR_BODY', 'CHANGE_BASE_REF',
  ]) delete childEnv[name];
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', env: { ...childEnv, ...env } });
  if (result.error) throw result.error;
  return result;
}

function git(cwd, ...args) {
  const result = command(cwd, 'git', args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(cwd, title, content) {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', title, '-m', content);
  return git(cwd, 'rev-parse', 'HEAD');
}

test('CLI reads committed Git state and GitHub PR metadata at the exact head', () => {
  const root = mkdtempSync(join(tmpdir(), 'baseline-change-'));
  fixtures.push(root);
  for (const dir of ['contract', 'config']) mkdirSync(join(root, dir));
  for (const name of ['change-contract.mjs', 'check-change.mjs', 'check-portfolio-contract.mjs', 'delivery-config.mjs', 'release-contract.mjs']) {
    copyFileSync(join(scriptRoot, 'contract', name), join(root, 'contract', name));
  }
  copyFileSync(join(scriptRoot, 'config', 'delivery.json'), join(root, 'config', 'delivery.json'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Baseline Test');
  git(root, 'config', 'user.email', 'baseline@example.invalid');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'baseline', version: '0.1.0', private: true }) + '\n');
  writeFileSync(join(root, 'implementation_plan.md'), plan(2, 3));
  const baseSha = commit(root, '[BASE-001] [INIT] Establish baseline', body());
  assert.equal(command(root, process.execPath, ['contract/check-change.mjs']).status, 0);

  git(root, 'switch', '-q', '-c', 'base-002-prove-process-contract');
  writeFileSync(join(root, 'implementation_plan.md'), plan(3));
  const title = '[BASE-002] [TEST] Prove process contract';
  const headSha = commit(root, title, body());
  const local = command(root, process.execPath, ['contract/check-change.mjs']);
  assert.equal(local.status, 0, local.stderr);

  const eventPath = join(root, 'event.json');
  const event = {
    pull_request: { title, body: body(), base: { sha: baseSha, ref: 'main' }, head: { sha: headSha, ref: 'base-002-prove-process-contract' } },
  };
  writeFileSync(eventPath, JSON.stringify(event));
  const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath };
  assert.equal(command(root, process.execPath, ['contract/check-change.mjs'], env).status, 0);
  event.pull_request.title = '[BASE-002] [TEST] Another title';
  writeFileSync(eventPath, JSON.stringify(event));
  const wrong = command(root, process.execPath, ['contract/check-change.mjs'], env);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /exactly equal/);
  event.pull_request.title = title;
  event.pull_request.body = `${body()}\nDifferent evidence`;
  writeFileSync(eventPath, JSON.stringify(event));
  const wrongBody = command(root, process.execPath, ['contract/check-change.mjs'], env);
  assert.equal(wrongBody.status, 1);
  assert.match(wrongBody.stderr, /PR body must exactly equal/);

  rmSync(eventPath);
  git(root, 'switch', '-q', 'main');
  writeFileSync(join(root, 'implementation_plan.md'), emptyPlan());
  commit(root, title, body());
  assert.equal(command(root, process.execPath, ['contract/check-change.mjs']).status, 0);

  git(root, 'tag', '-a', 'v0.1.0', '-m', 'Release v0.1.0');
  git(root, 'switch', '-q', '--detach', 'v0.1.0');
  assert.equal(command(root, process.execPath, ['contract/check-change.mjs']).status, 0);

  git(root, 'switch', '-q', 'main');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'baseline', version: '0.2.0', private: true }) + '\n');
  commit(root, '[BASE-003] [BUILD] Advance release version', body());
  git(root, 'switch', '-q', '--detach', 'HEAD');
  assert.match(command(root, process.execPath, ['contract/check-change.mjs']).stderr, /exact annotated semantic release tag/);
  git(root, 'tag', 'v0.2.0');
  assert.match(command(root, process.execPath, ['contract/check-change.mjs']).stderr, /requires an annotated tag/);
  git(root, 'tag', '-d', 'v0.2.0');
  git(root, 'tag', '-a', 'v0.3.0', '-m', 'Mismatched version');
  assert.match(command(root, process.execPath, ['contract/check-change.mjs']).stderr, /does not match package.json version/);
});
test('CLI checks a task PR into the release branch and a local release branch as its release PR', () => {
  const root = mkdtempSync(join(tmpdir(), 'baseline-release-'));
  fixtures.push(root);
  for (const dir of ['contract', 'docs', 'config']) mkdirSync(join(root, dir));
  for (const name of ['change-contract.mjs', 'check-change.mjs', 'check-portfolio-contract.mjs', 'delivery-config.mjs', 'release-contract.mjs']) {
    copyFileSync(join(scriptRoot, 'contract', name), join(root, 'contract', name));
  }
  copyFileSync(join(scriptRoot, 'config', 'delivery.json'), join(root, 'config', 'delivery.json'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Baseline Test');
  git(root, 'config', 'user.email', 'baseline@example.invalid');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'baseline', version: '0.1.0', private: true }) + '\n');
  writeFileSync(join(root, 'implementation_plan.md'), plan(2, 3));
  const mainSha = commit(root, '[BASE-001] [INIT] Establish baseline', body());
  git(root, 'branch', 'release/r001');

  git(root, 'switch', '-q', '-c', 'base-002-prove-process-contract');
  // A task that empties the queue leaves the shared template byte for byte, final newline included.
  writeFileSync(join(root, 'implementation_plan.md'), emptyPlan());
  writeFileSync(join(root, 'config/release.json'), JSON.stringify(r001('BASE-002'), null, 2) + '\n');
  commit(root, '[BASE-002] [TEST] Prove process contract', body());
  const emptied = command(root, process.execPath, ['contract/check-change.mjs']);
  assert.equal(emptied.status, 0, emptied.stderr);
  git(root, 'reset', '-q', '--hard', 'release/r001');
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'implementation_plan.md'), plan(3));
  writeFileSync(join(root, 'config/release.json'), JSON.stringify(r001('BASE-002'), null, 2) + '\n');
  const title = '[BASE-002] [TEST] Prove process contract';
  const taskSha = commit(root, title, body());
  const local = command(root, process.execPath, ['contract/check-change.mjs']);
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /Controlled BASE-002 candidate/);

  const eventPath = join(root, 'event.json');
  const event = {
    pull_request: { title, body: body(), base: { sha: mainSha, ref: 'release/r001' }, head: { sha: taskSha, ref: 'base-002-prove-process-contract' } },
  };
  writeFileSync(eventPath, JSON.stringify(event));
  const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath };
  assert.equal(command(root, process.execPath, ['contract/check-change.mjs'], env).status, 0);
  event.pull_request.base.ref = 'main';
  writeFileSync(eventPath, JSON.stringify(event));
  assert.equal(command(root, process.execPath, ['contract/check-change.mjs'], env).status, 0, 'BASE-002 predates the cut-over');
  event.pull_request.base.ref = 'release/r002';
  writeFileSync(eventPath, JSON.stringify(event));
  const wrong = command(root, process.execPath, ['contract/check-change.mjs'], env);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /must target the config\/release.json branch release\/r001/);
  rmSync(eventPath);

  git(root, 'switch', '-q', 'release/r001');
  git(root, 'merge', '-q', '--ff-only', 'base-002-prove-process-contract');

  const planChange = (branch, numbers) => {
    git(root, 'switch', '-q', '-c', branch, 'release/r001');
    writeFileSync(join(root, 'implementation_plan.md'), planAt(5, ...numbers));
    commit(root, `[PLAN] ${branch}`, body());
    return command(root, process.execPath, ['contract/check-change.mjs']);
  };
  const accept = (branch) => {
    git(root, 'switch', '-q', 'release/r001');
    git(root, 'merge', '-q', '--ff-only', branch);
  };
  const queued = planChange('plan-queue-later-work', [5, 3]);
  assert.equal(queued.status, 0, queued.stderr);
  assert.match(queued.stdout, /Controlled plan-only candidate/);
  accept('plan-queue-later-work');
  const dropped = planChange('plan-drop-later-work', [3]);
  assert.equal(dropped.status, 0, dropped.stderr);
  accept('plan-drop-later-work');
  assert.match(planChange('plan-reuse-retired-work', [4, 3]).stderr, /BASE-004: a new task takes an ID above BASE-005/,
    'BASE-005 was once queued, so its removal retires every ID up to it');
  git(root, 'switch', '-q', 'release/r001');
  const release = command(root, process.execPath, ['contract/check-change.mjs']);
  assert.equal(release.status, 0, release.stderr);
  assert.match(release.stdout, /Controlled r001 candidate/);
});


after(() => { for (const root of fixtures) rmSync(root, { recursive: true, force: true }); });
