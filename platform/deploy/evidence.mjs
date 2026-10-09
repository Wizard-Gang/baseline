// The caller's reproduction proof, read by the reusable deploy-worker workflow before any credential is reachable.
// A caller reproduces its tag with npm ci and npm run check in a job its deploy-worker.yml call needs. This module
// proves that from provider state alone: the current run and attempt from the Actions API, the caller workflow as
// committed at the tag, that job's own completed result, the vendored pin and the tag's published Release.
// Nothing here trusts a caller input, and missing or unreadable evidence fails; there is no local fallback check.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEPLOY_WORKFLOW = 'Wizard-Gang/baseline/.github/workflows/deploy-worker.yml';
const API = 'https://api.github.com';
const COMMIT = /^[0-9a-f]{40}$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE = /^[1-9]\d{0,19}$/;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;
const EVENTS = Object.freeze(['push', 'workflow_dispatch']);
// The only checkout refs a reproduction job may name: each resolves to the run's own commit.
const CHECKOUT_REFS = Object.freeze([
  '${{ github.sha }}', '${{ github.ref }}', '${{ github.event.pull_request.head.sha || github.sha }}',
]);
const MAX_JOBS = 100;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const indentOf = (line) => line.match(/^ */)[0].length;
const unquote = (value) => value.trim().replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');

/** The jobs of a block-style workflow, keyed by job ID, each with its own lines. */
function jobBlocks(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimEnd() === 'jobs:');
  const jobs = new Map();
  if (start < 0) return jobs;
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trimStart().startsWith('#')) {
      current?.push(line);
      continue;
    }
    if (indentOf(line) === 0) break;
    const key = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(line);
    if (key) jobs.set(key[1], (current = []));
    else current?.push(line);
  }
  return jobs;
}

/** A job's `needs`, as a scalar, a flow list or a block list. */
function needsOf(lines) {
  const index = lines.findIndex((line) => /^ {4}needs:/.test(line));
  if (index < 0) return [];
  const inline = lines[index].replace(/^ {4}needs:/, '').replace(/\s+#.*$/, '').trim();
  if (inline.startsWith('[')) return inline.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean);
  if (inline) return [unquote(inline)];
  const list = [];
  for (const line of lines.slice(index + 1)) {
    const item = /^ {6}- (.+)$/.exec(line);
    if (!item) break;
    list.push(unquote(item[1]));
  }
  return list;
}

/** Every shell command line a job runs, one-line `run:` values and literal blocks alike, trimmed. */
function commandLines(lines) {
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    if (!/^[|>][-+]?\s*$/.test(match[2])) {
      commands.push(match[2].trim());
      continue;
    }
    for (const line of lines.slice(index + 1)) {
      if (line.trim() && indentOf(line) <= match[1].length) break;
      if (line.trim()) commands.push(line.trim());
    }
  }
  return commands;
}

/** Every job a job needs, directly or through other needs: GitHub runs it only after all of them succeed. */
function neededJobs(jobs, id) {
  const seen = new Set();
  const pending = [...needsOf(jobs.get(id) ?? [])];
  while (pending.length) {
    const next = pending.shift();
    if (seen.has(next) || !jobs.has(next)) continue;
    seen.add(next);
    pending.push(...needsOf(jobs.get(next)));
  }
  return [...seen];
}

/**
 * Find the caller's reproduction job in its workflow as committed at the tag: the one job that the
 * deploy-worker.yml call needs, directly or through other needs, which runs npm ci and then npm run check.
 * @param {string} source the caller workflow text
 * @param {string} deploySha the deploy-worker.yml commit the run references
 * @returns {{ job: string, failures: string[] }} job is the name the jobs API reports
 */
export function callerReproduction(source, deploySha) {
  const jobs = jobBlocks(source ?? '');
  const callers = [...jobs].filter(([, lines]) => lines.some((line) => /^ {4}uses:\s*\S/.test(line)
    && line.replace(/\s+#.*$/, '').trim() === `uses: ${DEPLOY_WORKFLOW}@${deploySha}`));
  if (callers.length !== 1) return { job: '', failures: [`the caller workflow must call ${DEPLOY_WORKFLOW}@${deploySha} from exactly one job; found ${callers.length}`] };
  const [[caller, callerLines]] = callers;
  const candidates = neededJobs(jobs, caller).filter((need) => {
    const commands = commandLines(jobs.get(need));
    const install = commands.indexOf('npm ci');
    return install >= 0 && commands.indexOf('npm run check', install + 1) > install;
  });
  if (candidates.length !== 1) {
    return { job: '', failures: [`job ${caller} must need exactly one job that runs npm ci and then npm run check; found ${candidates.length}`] };
  }
  const [id] = candidates;
  const lines = jobs.get(id);
  const failures = [];
  if (!lines.some((line) => /^\s*node-version-file:\s*\.node-version\s*$/.test(line))) failures.push(`reproduction job ${id} must set up Node from .node-version`);
  if (lines.some((line) => /^\s*continue-on-error:/.test(line))) failures.push(`reproduction job ${id} must not continue on error`);
  if (lines.some((line) => /^ {6,}(?:- )?if:/.test(line))) failures.push(`reproduction job ${id} must not skip a step conditionally`);
  for (const line of lines) {
    const ref = /^\s*ref:\s*(.+)$/.exec(line);
    if (ref && !CHECKOUT_REFS.includes(unquote(ref[1]))) failures.push(`reproduction job ${id} must check out the run's own commit`);
  }
  const named = lines.find((line) => /^ {4}name:/.test(line));
  const job = named ? unquote(named.replace(/^ {4}name:/, '')) : id;
  if (!job || job.includes('${{')) failures.push(`reproduction job ${id} must have a literal name`);
  return { job, failures };
}

/**
 * The current run must be the caller's own, at the tag commit, in this attempt, and reference one pinned deploy-worker.yml.
 * @param {unknown} run GET /repos/{repository}/actions/runs/{runId}
 * @param {{ repository: string, runId: string, attempt: string, tag: string, commit: string }} expected
 * @returns {{ failures: string[], deploySha: string, path: string }}
 */
export function checkRun(run, { repository, runId, attempt, tag, commit }) {
  if (!isObject(run)) return { failures: ['the run evidence is not an object'], deploySha: '', path: '' };
  const failures = [];
  if (String(run.id) !== runId) failures.push(`run evidence is for run ${JSON.stringify(run.id)}, not ${runId}`);
  if (String(run.run_attempt) !== attempt) failures.push(`run evidence is for attempt ${JSON.stringify(run.run_attempt)}, not ${attempt}`);
  if (run.repository?.full_name !== repository) failures.push(`run belongs to ${JSON.stringify(run.repository?.full_name)}, not ${repository}`);
  if (run.head_repository?.full_name !== repository) failures.push('run head repository is not the caller repository');
  if (run.head_sha !== commit) failures.push(`run head ${JSON.stringify(run.head_sha)} is not ${commit}`);
  if (run.head_branch !== tag && run.head_branch !== 'main') failures.push(`run ref ${JSON.stringify(run.head_branch)} is neither ${tag} nor main`);
  if (!EVENTS.includes(run.event)) failures.push(`run event ${JSON.stringify(run.event)} is not push or workflow_dispatch`);
  const path = typeof run.path === 'string' && WORKFLOW_PATH.test(run.path) ? run.path : '';
  if (!path) failures.push('run workflow path is not a repository workflow');
  const references = Array.isArray(run.referenced_workflows) ? run.referenced_workflows : [];
  const deploys = references.filter((reference) => typeof reference?.path === 'string' && reference.path.startsWith(`${DEPLOY_WORKFLOW}@`));
  let deploySha = '';
  if (deploys.length !== 1) failures.push(`run must reference ${DEPLOY_WORKFLOW} exactly once; found ${deploys.length}`);
  else if (!COMMIT.test(deploys[0].sha ?? '') || deploys[0].path !== `${DEPLOY_WORKFLOW}@${deploys[0].sha}`) {
    failures.push(`${DEPLOY_WORKFLOW} must be pinned to a full commit`);
  } else deploySha = deploys[0].sha;
  return { failures, deploySha, path };
}

/**
 * @param {unknown} jobs GET /repos/{repository}/actions/runs/{runId}/attempts/{attempt}/jobs
 * @param {{ job: string, commit: string, attempt: string }} expected
 * @returns {string[]} failures
 */
export function checkReproductionJob(jobs, { job, commit, attempt }) {
  const list = isObject(jobs) && Array.isArray(jobs.jobs) ? jobs.jobs : null;
  if (!list) return ['the jobs evidence is not a job list'];
  if (jobs.total_count !== list.length) return [`the attempt lists ${JSON.stringify(jobs.total_count)} jobs; at most ${MAX_JOBS} are read`];
  const matches = list.filter((entry) => entry?.name === job);
  if (matches.length !== 1) return [`the attempt must hold exactly one job named ${JSON.stringify(job)}; found ${matches.length}`];
  const [entry] = matches;
  const failures = [];
  if (entry.status !== 'completed' || entry.conclusion !== 'success') {
    failures.push(`reproduction job ${JSON.stringify(job)} is ${entry.status}/${entry.conclusion}, not completed/success`);
  }
  if (entry.head_sha !== commit) failures.push(`reproduction job ran at ${JSON.stringify(entry.head_sha)}, not ${commit}`);
  if (String(entry.run_attempt) !== attempt) failures.push(`reproduction job ran in attempt ${JSON.stringify(entry.run_attempt)}, not ${attempt}`);
  return failures;
}

/**
 * @param {unknown} release GET /repos/{repository}/releases/tags/{tag}
 * @param {string} tag
 * @returns {string[]} failures
 */
export function checkRelease(release, tag) {
  if (!isObject(release)) return [`no published Release for ${tag}`];
  const failures = [];
  if (release.tag_name !== tag) failures.push(`Release names tag ${JSON.stringify(release.tag_name)}, not ${tag}`);
  if (release.draft !== false || typeof release.published_at !== 'string' || !release.published_at) failures.push(`the Release for ${tag} is not published`);
  return failures;
}

/** The vendored platform/ must come from the deploy-worker.yml commit the run calls. */
export function checkVendorPin(lockText, deploySha) {
  let lock;
  try {
    lock = JSON.parse(lockText);
  } catch {
    return ['platform/vendor.lock.json is not readable JSON'];
  }
  return lock?.commit === deploySha ? [] : [`platform/vendor.lock.json pins ${JSON.stringify(lock?.commit)}, but the run calls deploy-worker.yml@${deploySha}`];
}

/** One bounded, read-only GitHub API GET. Only the status is ever reported, never a response body. */
async function get(fetch, token, path, what) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      redirect: 'error',
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { failure: `cannot read the ${what}: request failed` };
  }
  if (response.status === 404) return { body: null };
  if (response.status === 401 || response.status === 403) {
    return { failure: `cannot read the ${what} (HTTP ${response.status}); the caller job must grant actions: read and contents: read` };
  }
  if (response.status !== 200) return { failure: `cannot read the ${what} (HTTP ${response.status})` };
  try {
    return { body: JSON.parse(await response.text()) };
  } catch {
    return { failure: `the ${what} is not JSON` };
  }
}

/**
 * Prove the caller's reproduction from the Actions API and the checkout at the tag.
 * @param {{ tag: string, commit: string, env: Record<string, string | undefined>, root?: string,
 *   fetch?: typeof globalThis.fetch, readFile?: (path: string) => string }} input
 * @returns {Promise<{ failures: string[], job: string }>}
 */
export async function verifyEvidence({ tag, commit, env, root = '.', fetch = globalThis.fetch, readFile = (path) => readFileSync(path, 'utf8') }) {
  const repository = env.GITHUB_REPOSITORY ?? '';
  const runId = env.GITHUB_RUN_ID ?? '';
  const attempt = env.GITHUB_RUN_ATTEMPT ?? '';
  const token = env.GITHUB_TOKEN ?? '';
  if (!TAG.test(tag) || !COMMIT.test(commit)) return { failures: ['the tag or commit is malformed'], job: '' };
  if (!REPOSITORY.test(repository) || !POSITIVE.test(runId) || !POSITIVE.test(attempt) || !token) {
    return { failures: ['GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT and GITHUB_TOKEN must identify the current run'], job: '' };
  }
  const runRead = await get(fetch, token, `/repos/${repository}/actions/runs/${runId}`, 'current run');
  if (runRead.failure) return { failures: [runRead.failure], job: '' };
  const run = checkRun(runRead.body, { repository, runId, attempt, tag, commit });
  if (run.failures.length) return { failures: run.failures, job: '' };

  let source;
  let lockText;
  try {
    source = readFile(join(root, run.path));
    lockText = readFile(join(root, 'platform/vendor.lock.json'));
  } catch {
    return { failures: [`cannot read ${run.path} or platform/vendor.lock.json at ${commit}`], job: '' };
  }
  const pin = checkVendorPin(lockText, run.deploySha);
  const caller = callerReproduction(source, run.deploySha);
  if (pin.length || caller.failures.length) return { failures: [...pin, ...caller.failures], job: caller.job };

  const jobsRead = await get(fetch, token, `/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${MAX_JOBS}`, 'attempt jobs');
  if (jobsRead.failure) return { failures: [jobsRead.failure], job: caller.job };
  const jobFailures = checkReproductionJob(jobsRead.body, { job: caller.job, commit, attempt });
  if (jobFailures.length) return { failures: jobFailures, job: caller.job };

  const releaseRead = await get(fetch, token, `/repos/${repository}/releases/tags/${tag}`, 'tag Release');
  if (releaseRead.failure) return { failures: [releaseRead.failure], job: caller.job };
  return { failures: checkRelease(releaseRead.body, tag), job: caller.job };
}
