#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateHistory, validatePlan, validatePullRequest } from './change-contract.mjs';
import { RELEASE_TAG } from './release-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trimEnd();
const shaPattern = /^[0-9a-f]{40}$/;

function checkedSha(value, label) {
  if (!shaPattern.test(value ?? '')) throw new Error(`${label} must be a full Git SHA`);
  return value;
}

function recordAt(ref) {
  checkedSha(ref, 'commit');
  const [sha, parentLine, subject, ...bodyParts] = git('show', '-s', '--format=%H%x1f%P%x1f%s%x1f%b', ref).split('\x1f');
  return { sha, parents: parentLine.split(' ').filter(Boolean), subject, body: bodyParts.join('\x1f') };
}

function historyAt(ref) {
  checkedSha(ref, 'history endpoint');
  return git('rev-list', '--first-parent', '--reverse', ref).split('\n').filter(Boolean).map(recordAt);
}

function planAt(ref) {
  checkedSha(ref, 'plan endpoint');
  if (!git('ls-tree', '--name-only', ref, '--', 'implementation_plan.md')) return null;
  return git('show', `${ref}:implementation_plan.md`);
}

function currentHead() {
  return checkedSha(git('rev-parse', 'HEAD'), 'checked-out HEAD');
}

function localBranchOrReleaseTag() {
  const branch = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (branch.status === 0) return { branch: branch.stdout.trim(), tag: null };
  if (branch.status !== 1) throw new Error(`unable to inspect local branch: ${branch.stderr.trim()}`);

  const described = spawnSync('git', ['describe', '--exact-match', '--tags', 'HEAD'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = described.stdout.trim();
  if (described.status !== 0 || !RELEASE_TAG.test(tag)) {
    throw new Error('detached HEAD requires an exact annotated semantic release tag');
  }
  if (git('cat-file', '-t', `refs/tags/${tag}`) !== 'tag' || git('rev-parse', `${tag}^{commit}`) !== currentHead()) {
    throw new Error('detached HEAD requires an annotated tag at the checked-out commit');
  }
  const version = JSON.parse(git('show', `${currentHead()}:package.json`)).version;
  if (version !== tag.slice(1)) throw new Error(`detached release tag ${tag} does not match package.json version ${version}`);
  return { branch: null, tag };
}

function validateAccepted(ref) {
  const history = validateHistory(historyAt(ref));
  const plan = validatePlan(planAt(ref), history.lastId + 1);
  return { failures: [...history.failures, ...plan.failures], lastId: history.lastId };
}

function validateCandidate({ baseSha, headSha, branch, title, targetBranch, prBody }) {
  checkedSha(baseSha, 'base SHA');
  checkedSha(headSha, 'head SHA');
  if (currentHead() !== headSha) throw new Error(`checkout HEAD does not equal exact candidate head ${headSha}`);
  const head = recordAt(headSha);
  const result = validatePullRequest({
    baseSha,
    headSha,
    branch,
    title,
    targetBranch,
    head,
    prBody: prBody === undefined ? head.body : prBody,
    baseHistory: historyAt(baseSha),
    basePlan: planAt(baseSha),
    headPlan: planAt(headSha),
    mergeBaseSha: git('merge-base', baseSha, headSha),
    commitRangeCount: Number(git('rev-list', '--count', `${baseSha}..${headSha}`)),
  });
  return result;
}

function contextFromEvent() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventName === 'pull_request') {
    if (!process.env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH is required for pull_request');
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const pr = event.pull_request;
    if (!pr) throw new Error('pull_request payload is missing');
    return {
      kind: 'candidate',
      baseSha: pr.base?.sha,
      headSha: pr.head?.sha,
      branch: pr.head?.ref,
      title: pr.title,
      prBody: pr.body,
      targetBranch: pr.base?.ref,
    };
  }
  if (eventName && !['push', 'workflow_dispatch'].includes(eventName)) {
    throw new Error(`unsupported GitHub event ${eventName}`);
  }
  if (!eventName && (process.env.CHANGE_BASE_SHA || process.env.CHANGE_HEAD_SHA || process.env.CHANGE_HEAD_REF || process.env.CHANGE_PR_TITLE)) {
    return {
      kind: 'candidate',
      baseSha: process.env.CHANGE_BASE_SHA,
      headSha: process.env.CHANGE_HEAD_SHA,
      branch: process.env.CHANGE_HEAD_REF,
      title: process.env.CHANGE_PR_TITLE,
      prBody: process.env.CHANGE_PR_BODY,
      targetBranch: 'main',
    };
  }
  if (eventName) return { kind: 'accepted', headSha: process.env.GITHUB_SHA || currentHead() };
  const { branch, tag } = localBranchOrReleaseTag();
  if (tag) return { kind: 'accepted', headSha: currentHead() };
  if (branch === 'main') return { kind: 'accepted', headSha: currentHead() };
  const baseSha = checkedSha(git('rev-parse', 'main'), 'local main');
  const headSha = currentHead();
  return { kind: 'candidate', baseSha, headSha, branch, title: recordAt(headSha).subject, targetBranch: 'main', prBody: recordAt(headSha).body };
}

try {
  const context = contextFromEvent();
  let result;
  if (context.kind === 'candidate') {
    result = validateCandidate(context);
  } else {
    checkedSha(context.headSha, 'event head SHA');
    if (currentHead() !== context.headSha) throw new Error(`checkout HEAD does not equal event head ${context.headSha}`);
    result = validateAccepted(context.headSha);
  }
  if (result.failures.length) {
    for (const failure of result.failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(context.kind === 'candidate'
      ? `Controlled ${result.nextId} candidate at exact head ${context.headSha} passed.`
      : `Controlled main history through BASE-${String(result.lastId).padStart(3, '0')} passed.`);
  }
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
}
