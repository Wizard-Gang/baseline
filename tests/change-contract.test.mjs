import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import {
  CONTROLLED_TYPES,
  parseBranch, parseTitle, validateBody, validateHistory, validatePlan, validatePullRequest,
} from '../scripts/change-contract.mjs';

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
- Authorities: scripts/change-contract.mjs.
`;

const plan = (...numbers) => `# Implementation plan\n\n## Open tasks\n\n${numbers.map((n) => task(n)).join('\n')}`;
const emptyPlan = readFileSync(join(scriptRoot, 'implementation_plan.md'), 'utf8');

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

test('first-parent main history begins at controlled BASE-001 and stays sequential', () => {
  const first = record(1);
  const second = record(2, first.sha);
  assert.deepEqual(validateHistory([first, second]).failures, []);
  assert.equal(validateHistory([first, second]).lastId, 2);

  assert.match(validateHistory([{ ...first, subject: 'Bootstrap baseline repository' }]).failures.join(' '), /invalid controlled title/);
  assert.match(validateHistory([first, { ...second, subject: first.subject }]).failures.join(' '), /expected BASE-002/);
  assert.match(validateHistory([first, { ...second, parents: [first.sha, 'other'] }]).failures.join(' '), /without merge commits/);
  assert.match(validateHistory([first, { ...second, body: '' }]).failures.join(' '), /exactly one Change:/);
});

test('active plan has contiguous future tasks and no completed ledger', () => {
  assert.match(validatePlan(null, 2).failures.join(' '), /permanent implementation_plan.md is missing/);
  assert.deepEqual(validatePlan(emptyPlan, 2).failures, []);
  assert.deepEqual(validatePlan(plan(2, 3), 2).failures, []);
  assert.deepEqual(validatePlan(plan(2).replaceAll(/^- /gm, ''), 2).failures, []);
  assert.match(validatePlan(plan(3), 2).failures.join(' '), /expected BASE-002/);
  assert.match(validatePlan(plan(2, 4), 2).failures.join(' '), /expected BASE-003/);
  assert.match(validatePlan('# Plan\n\n## Completed\n\n' + task(2), 2).failures.join(' '), /historical sections/);
  assert.match(validatePlan(plan(2).replace('- Validation: node --test tests/change-contract.test.mjs.', ''), 2).failures.join(' '), /missing nonempty Validation/);
});

test('PR binds exact head, branch, next ID, single commit, and first task retirement', () => {
  assert.deepEqual(validatePullRequest(candidate()).failures, []);
  assert.match(validatePullRequest(candidate({ title: '[BASE-002] [BUILD] Different title' })).failures.join(' '), /exactly equal/);
  assert.match(validatePullRequest(candidate({ prBody: `${body()}\nChanged` })).failures.join(' '), /PR body must exactly equal/);
  assert.deepEqual(validatePullRequest(candidate({ prBody: body().replaceAll('\n', '\r\n') + '\r\n' })).failures, []);
  assert.match(validatePullRequest(candidate({ branch: 'base-003-wrong-id' })).failures.join(' '), /does not match PR/);
  assert.match(validatePullRequest(candidate({ targetBranch: 'develop' })).failures.join(' '), /must target main/);
  assert.match(validatePullRequest(candidate({ commitRangeCount: 2 })).failures.join(' '), /one controlled commit/);
  assert.match(validatePullRequest(candidate({ mergeBaseSha: 'stale-base' })).failures.join(' '), /direct child/);
  assert.match(validatePullRequest(candidate({ basePlan: plan(3, 4) })).failures.join(' '), /base plan: BASE-003: expected BASE-002/);
  assert.match(validatePullRequest(candidate({ headPlan: plan(2, 3) })).failures.join(' '), /head plan: BASE-002: expected BASE-003/);
  assert.match(validatePullRequest(candidate({ headPlan: null })).failures.join(' '), /preserve remaining future tasks/);
  assert.match(validatePullRequest(candidate({ basePlan: plan(2), headPlan: plan(3) })).failures.join(' '), /final task must leave the queue empty/);
  assert.deepEqual(validatePullRequest(candidate({ basePlan: plan(2), headPlan: emptyPlan })).failures, []);
  assert.deepEqual(validatePullRequest(candidate({ basePlan: emptyPlan, headPlan: plan(3) })).failures, []);
  assert.match(validatePullRequest(candidate({ basePlan: emptyPlan, headPlan: emptyPlan })).failures.join(' '), /must publish a future-task plan/);
});

function command(cwd, program, args, env = {}) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
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
  mkdirSync(join(root, 'scripts'));
  for (const name of ['change-contract.mjs', 'check-change.mjs', 'release-contract.mjs']) {
    copyFileSync(join(scriptRoot, 'scripts', name), join(root, 'scripts', name));
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Baseline Test');
  git(root, 'config', 'user.email', 'baseline@example.invalid');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'baseline', version: '0.1.0', private: true }) + '\n');
  writeFileSync(join(root, 'implementation_plan.md'), plan(2, 3));
  const baseSha = commit(root, '[BASE-001] [INIT] Establish baseline', body());
  assert.equal(command(root, process.execPath, ['scripts/check-change.mjs']).status, 0);

  git(root, 'switch', '-q', '-c', 'base-002-prove-process-contract');
  writeFileSync(join(root, 'implementation_plan.md'), plan(3));
  const title = '[BASE-002] [TEST] Prove process contract';
  const headSha = commit(root, title, body());
  const local = command(root, process.execPath, ['scripts/check-change.mjs']);
  assert.equal(local.status, 0, local.stderr);

  const eventPath = join(root, 'event.json');
  const event = {
    pull_request: { title, body: body(), base: { sha: baseSha, ref: 'main' }, head: { sha: headSha, ref: 'base-002-prove-process-contract' } },
  };
  writeFileSync(eventPath, JSON.stringify(event));
  const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath };
  assert.equal(command(root, process.execPath, ['scripts/check-change.mjs'], env).status, 0);
  event.pull_request.title = '[BASE-002] [TEST] Another title';
  writeFileSync(eventPath, JSON.stringify(event));
  const wrong = command(root, process.execPath, ['scripts/check-change.mjs'], env);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /exactly equal/);
  event.pull_request.title = title;
  event.pull_request.body = `${body()}\nDifferent evidence`;
  writeFileSync(eventPath, JSON.stringify(event));
  const wrongBody = command(root, process.execPath, ['scripts/check-change.mjs'], env);
  assert.equal(wrongBody.status, 1);
  assert.match(wrongBody.stderr, /PR body must exactly equal/);

  rmSync(eventPath);
  git(root, 'switch', '-q', 'main');
  writeFileSync(join(root, 'implementation_plan.md'), emptyPlan);
  commit(root, title, body());
  assert.equal(command(root, process.execPath, ['scripts/check-change.mjs']).status, 0);

  git(root, 'tag', '-a', 'v0.1.0', '-m', 'Release v0.1.0');
  git(root, 'switch', '-q', '--detach', 'v0.1.0');
  assert.equal(command(root, process.execPath, ['scripts/check-change.mjs']).status, 0);

  git(root, 'switch', '-q', 'main');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'baseline', version: '0.2.0', private: true }) + '\n');
  commit(root, '[BASE-003] [BUILD] Advance release version', body());
  git(root, 'switch', '-q', '--detach', 'HEAD');
  assert.match(command(root, process.execPath, ['scripts/check-change.mjs']).stderr, /exact annotated semantic release tag/);
  git(root, 'tag', 'v0.2.0');
  assert.match(command(root, process.execPath, ['scripts/check-change.mjs']).stderr, /requires an annotated tag/);
  git(root, 'tag', '-d', 'v0.2.0');
  git(root, 'tag', '-a', 'v0.3.0', '-m', 'Mismatched version');
  assert.match(command(root, process.execPath, ['scripts/check-change.mjs']).stderr, /does not match package.json version/);
});

after(() => { for (const root of fixtures) rmSync(root, { recursive: true, force: true }); });
