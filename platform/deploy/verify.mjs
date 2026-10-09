#!/usr/bin/env node
// The deploy checks the reusable deploy-worker workflow runs from the consumer's vendored platform/:
//   node platform/deploy/verify.mjs host --worker <label>
//       print the Worker's declared public host
//   node platform/deploy/verify.mjs evidence --worker <label> --tag <vX.Y.Z> --commit <sha>
//       the current run's caller reproduction job passed at the tag commit, and the tag's Release is published
//       (reads GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT and GITHUB_TOKEN; see evidence.mjs)
//   node platform/deploy/verify.mjs traffic --worker <label> --deploy-output <ndjson> --status <json>
//       the version wrangler just deployed serves 100% of traffic
//   node platform/deploy/verify.mjs observe --worker <label> --tag <vX.Y.Z> --commit <sha> --deploy-output <ndjson>
//       --status <json> --result <path> [--timeout <s>] [--interval <s>]
//       poll https://<host>/version.json until app, version and commit match, then check /health.json and the root
//       page's same-origin scripts and stylesheets, and only then write the one compact deploy result to <path>
// Exit codes: 0 verified, 1 not verified, 2 usage error. `evidence` reads only the GitHub API; `observe` reads only
// the Worker's public host.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DESIRED } from '../conformance/desired.mjs';
import { verifyEvidence } from './evidence.mjs';

const USAGE = 'usage: verify.mjs host --worker <label> | evidence --worker <label> --tag <vX.Y.Z> --commit <sha>'
  + ' | traffic --worker <label> --deploy-output <ndjson> --status <json>'
  + ' | observe --worker <label> --tag <vX.Y.Z> --commit <sha> --deploy-output <ndjson> --status <json> --result <path>'
  + ' [--timeout <s>] [--interval <s>]';
// Each command's required and optional options.
const COMMANDS = {
  host: [['worker'], []],
  evidence: [['worker', 'tag', 'commit'], []],
  traffic: [['worker', 'deploy-output', 'status'], []],
  observe: [['worker', 'tag', 'commit', 'deploy-output', 'status', 'result'], ['timeout', 'interval']],
};
const TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE = /^[1-9]\d{0,19}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_REDIRECTS = 3;
const MAX_ASSETS = 20;
const REQUEST_TIMEOUT_MS = 15_000;

/** @param {string} label */
export function hostFor(label) {
  const worker = Object.hasOwn(DESIRED.workers, label) ? DESIRED.workers[label] : null;
  if (!worker) throw new Error(`unknown Worker ${JSON.stringify(label)}`);
  return worker.host;
}

/** The single deploy record wrangler wrote to WRANGLER_OUTPUT_FILE_PATH, or the reason there is not exactly one. */
function deployRecord(deployOutput) {
  const records = [];
  for (const [index, line] of deployOutput.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      return { failure: `deploy output line ${index + 1} is not JSON` };
    }
  }
  const deploys = records.filter((record) => record?.type === 'deploy');
  return deploys.length === 1 ? { deploy: deploys[0] } : { failure: `deploy output must hold exactly one deploy record; found ${deploys.length}` };
}

/**
 * The single deploy record wrangler wrote to WRANGLER_OUTPUT_FILE_PATH, and the Worker's current deployment
 * from `wrangler deployments status --json`, must name the same version at 100% of traffic.
 * @param {{ label: string, deployOutput: string, status: unknown }} input
 * @returns {string[]} failures
 */
export function checkTraffic({ label, deployOutput, status }) {
  const { deploy, failure } = deployRecord(deployOutput);
  if (failure) return [failure];
  const failures = [];
  if (deploy.worker_name !== label) failures.push(`deploy record names Worker ${JSON.stringify(deploy.worker_name)}, expected ${label}`);
  if (typeof deploy.version_id !== 'string' || !deploy.version_id) failures.push('deploy record has no version_id');
  const versions = status && typeof status === 'object' && !Array.isArray(status) ? status.versions : undefined;
  if (!Array.isArray(versions) || versions.length !== 1) {
    failures.push(`deployment status must hold exactly one version; found ${Array.isArray(versions) ? versions.length : 0}`);
    return failures;
  }
  const [active] = versions;
  if (active?.version_id !== deploy.version_id) {
    failures.push(`active version ${JSON.stringify(active?.version_id)} is not the deployed ${JSON.stringify(deploy.version_id)}`);
  }
  if (active?.percentage !== 100) failures.push(`active version serves ${JSON.stringify(active?.percentage)}% of traffic, expected 100`);
  return failures;
}

/**
 * @param {unknown} body the parsed /version.json
 * @param {{ label: string, version: string, commit: string }} expected
 * @returns {string[]} failures
 */
export function checkIdentity(body, { label, version, commit }) {
  const live = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return [['app', label], ['version', version], ['commit', commit]]
    .filter(([key, value]) => live[key] !== value)
    .map(([key, value]) => `${key} is ${JSON.stringify(live[key])}, expected ${JSON.stringify(value)}`);
}

/**
 * @param {unknown} body the parsed /health.json
 * @param {{ label: string, version: string }} expected
 * @returns {string[]} failures
 */
export function checkHealth(body, { label, version }) {
  const live = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return [['status', 'ok'], ['app', label], ['version', version]]
    .filter(([key, value]) => live[key] !== value)
    .map(([key, value]) => `health ${key} is ${JSON.stringify(live[key])}, expected ${JSON.stringify(value)}`);
}

const challenged = (response) => response.headers?.get?.('cf-mitigated') === 'challenge';
const request = (fetch, url, redirect = 'error') => fetch(url, {
  redirect, cache: 'no-store', headers: { accept: 'application/json, text/html;q=0.9, */*;q=0.1' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});

/**
 * Poll the public /version.json until it reports the expected identity. A Cloudflare challenge is reported
 * apart from a timeout; neither is ever answered by deploying again.
 * @param {{ label: string, version: string, commit: string, timeoutMs?: number, intervalMs?: number,
 *   fetch?: typeof globalThis.fetch, sleep?: (ms: number) => Promise<void>, now?: () => number, log?: (line: string) => void }} input
 * @returns {Promise<string[]>} failures; empty once the identity matched
 */
export async function pollVersion({
  label, version, commit, timeoutMs = 300_000, intervalMs = 10_000,
  fetch = globalThis.fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = Date.now, log = console.log,
}) {
  const url = `https://${hostFor(label)}/version.json?deploy=${commit}`;
  const deadline = now() + timeoutMs;
  let last = 'no response';
  let challenge = false;
  for (let attempt = 1; ; attempt += 1) {
    challenge = false;
    try {
      const response = await request(fetch, url);
      const text = await response.text();
      if (challenged(response)) {
        challenge = true;
        last = `Cloudflare challenged the runner (HTTP ${response.status})`;
      } else if (response.status !== 200) last = `HTTP ${response.status}`;
      else {
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
        const failures = body === undefined ? ['body is not JSON'] : checkIdentity(body, { label, version, commit });
        if (!failures.length) {
          log(`${url} reports ${label} ${version} at ${commit}`);
          return [];
        }
        last = failures.join('; ');
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    log(`attempt ${attempt}: ${last}`);
    if (now() + intervalMs > deadline) {
      return [challenge
        ? `${url} stayed behind a Cloudflare challenge until the timeout: ${last}`
        : `${url} did not report ${version} at ${commit} before the timeout: ${last}`];
    }
    await sleep(intervalMs);
  }
}

/** One GET of the public host; a response body is read but never echoed into a failure. */
async function observeOnce(fetch, url, redirect = 'error') {
  try {
    const response = await request(fetch, url, redirect);
    const text = await response.text();
    if (challenged(response)) return { failure: `${url}: Cloudflare challenged the runner (HTTP ${response.status})` };
    return { response, text };
  } catch (error) {
    return { failure: `${url}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * /health.json must report ok with the deployed label and version.
 * @param {{ label: string, version: string, commit: string, fetch?: typeof globalThis.fetch }} input
 * @returns {Promise<string[]>} failures
 */
export async function verifyHealth({ label, version, commit, fetch = globalThis.fetch }) {
  const url = `https://${hostFor(label)}/health.json?deploy=${commit}`;
  const { response, text, failure } = await observeOnce(fetch, url);
  if (failure) return [failure];
  if (response.status !== 200) return [`${url}: HTTP ${response.status}`];
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return [`${url}: body is not JSON`];
  }
  return checkHealth(body, { label, version });
}

/**
 * The same-origin scripts and stylesheets an HTML page names, in order and without duplicates.
 * @param {string} html @param {string} pageUrl
 * @returns {{ url: string, kind: 'script' | 'style' }[]}
 */
export function pageAssets(html, pageUrl) {
  const origin = new URL(pageUrl).origin;
  const assets = new Map();
  const attribute = (tag, name) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(1).find((value) => value !== undefined);
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    let kind;
    let reference;
    if (/^<script/i.test(tag)) {
      kind = 'script';
      reference = attribute(tag, 'src');
    } else {
      const rel = (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
      if (rel.includes('stylesheet')) kind = 'style';
      else if (rel.includes('modulepreload')) kind = 'script';
      reference = attribute(tag, 'href');
    }
    if (!kind || !reference) continue;
    let url;
    try {
      url = new URL(reference, pageUrl);
    } catch {
      continue;
    }
    if (url.origin === origin && !assets.has(url.href)) assets.set(url.href, { url: url.href, kind });
  }
  return [...assets.values()];
}

/**
 * The root page, after at most three same-origin redirects, must be HTML, and each same-origin script and
 * stylesheet it names (at most 20) must load with a matching type.
 * @param {{ label: string, fetch?: typeof globalThis.fetch }} input
 * @returns {Promise<{ failures: string[], assets: number }>}
 */
export async function verifyAssets({ label, fetch = globalThis.fetch }) {
  const origin = `https://${hostFor(label)}`;
  let url = `${origin}/`;
  let page;
  for (let hop = 0; ; hop += 1) {
    const { response, text, failure } = await observeOnce(fetch, url, 'manual');
    if (failure) return { failures: [failure], assets: 0 };
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get?.('location');
      let next;
      try {
        next = new URL(location ?? '', url);
      } catch {
        next = null;
      }
      if (!location || !next || next.origin !== origin) return { failures: [`${url}: HTTP ${response.status} leaves ${origin}`], assets: 0 };
      if (hop >= MAX_REDIRECTS) return { failures: [`${origin}/ redirects more than ${MAX_REDIRECTS} times`], assets: 0 };
      url = next.href;
      continue;
    }
    page = { response, text };
    break;
  }
  const type = page.response.headers?.get?.('content-type') ?? '';
  if (page.response.status !== 200 || !/^text\/html\b/i.test(type)) return { failures: [`${url}: HTTP ${page.response.status} ${type || 'without a type'}, expected HTML`], assets: 0 };
  const assets = pageAssets(page.text, url);
  if (assets.length > MAX_ASSETS) return { failures: [`${url} names ${assets.length} same-origin scripts and stylesheets; at most ${MAX_ASSETS} are checked`], assets: 0 };
  const failures = [];
  for (const asset of assets) {
    const { response, text, failure } = await observeOnce(fetch, asset.url);
    if (failure) {
      failures.push(failure);
      continue;
    }
    const assetType = response.headers?.get?.('content-type') ?? '';
    const expected = asset.kind === 'script' ? /^(?:text|application)\/javascript\b/i : /^text\/css\b/i;
    if (response.status !== 200 || !expected.test(assetType) || !text.length) {
      failures.push(`${asset.url}: HTTP ${response.status} ${assetType || 'without a type'}, expected a non-empty ${asset.kind === 'script' ? 'script' : 'stylesheet'}`);
    }
  }
  return { failures, assets: assets.length };
}

// The deploy result's only fields. Each value must match its shape, so no account data, credential or raw
// provider payload can reach the reusable-workflow output.
const CHECKS = Object.freeze(['reproduction', 'traffic', 'version', 'health', 'assets']);
const RESULT_FIELDS = Object.freeze({
  schema: (value) => value === 1,
  worker: (value) => typeof value === 'string' && Object.hasOwn(DESIRED.workers, value),
  host: (value) => Object.values(DESIRED.workers).some((worker) => worker.host === value),
  repository: (value) => typeof value === 'string' && REPOSITORY.test(value),
  run_id: (value) => Number.isSafeInteger(value) && value > 0,
  run_attempt: (value) => Number.isSafeInteger(value) && value > 0,
  tag: (value) => typeof value === 'string' && TAG.test(value),
  commit: (value) => typeof value === 'string' && COMMIT.test(value),
  observed_at: (value) => typeof value === 'string' && ISO_TIME.test(value),
  worker_version_id: (value) => typeof value === 'string' && VERSION_ID.test(value),
  traffic_percentage: (value) => value === 100,
  assets_checked: (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_ASSETS,
  checks: (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).join() === CHECKS.join() && CHECKS.every((name) => value[name] === 'passed'),
});

/**
 * @param {unknown} result
 * @returns {string[]} failures; empty only for exactly the whitelisted fields with safe values
 */
export function validateResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return ['the deploy result must be an object'];
  const failures = [];
  const keys = Object.keys(result);
  for (const key of keys) if (!Object.hasOwn(RESULT_FIELDS, key)) failures.push(`the deploy result must not carry ${JSON.stringify(key)}`);
  for (const [key, valid] of Object.entries(RESULT_FIELDS)) if (!valid(result[key])) failures.push(`the deploy result ${key} is missing or unsafe`);
  if (!failures.length && result.host !== hostFor(result.worker)) failures.push('the deploy result host does not belong to its worker');
  return failures;
}

/**
 * Build the result from observed values only, copying each whitelisted field and nothing else.
 * @returns {{ result?: object, failures: string[] }}
 */
export function buildResult({ label, tag, commit, env, deploy, assets, observedAt }) {
  const result = {
    schema: 1,
    worker: label,
    host: hostFor(label),
    repository: env.GITHUB_REPOSITORY,
    run_id: POSITIVE.test(env.GITHUB_RUN_ID ?? '') ? Number(env.GITHUB_RUN_ID) : null,
    run_attempt: POSITIVE.test(env.GITHUB_RUN_ATTEMPT ?? '') ? Number(env.GITHUB_RUN_ATTEMPT) : null,
    tag,
    commit,
    observed_at: observedAt,
    worker_version_id: deploy?.version_id,
    traffic_percentage: 100,
    assets_checked: assets,
    checks: Object.fromEntries(CHECKS.map((name) => [name, 'passed'])),
  };
  const failures = validateResult(result);
  return failures.length ? { failures } : { result, failures };
}

/**
 * Everything observed after the deploy, in order; the result exists only if every observation passed.
 * @returns {Promise<{ failures: string[], result?: object }>}
 */
export async function observe({ label, tag, commit, deployOutput, status, env, timeoutMs, intervalMs, now = Date.now, log = console.log, ...io }) {
  const version = TAG.exec(tag)[1];
  const traffic = checkTraffic({ label, deployOutput, status });
  if (traffic.length) return { failures: traffic };
  const converged = await pollVersion({ label, version, commit, timeoutMs, intervalMs, now, log, ...io });
  if (converged.length) return { failures: converged };
  const health = await verifyHealth({ label, version, commit, fetch: io.fetch });
  if (health.length) return { failures: health };
  const assets = await verifyAssets({ label, fetch: io.fetch });
  if (assets.failures.length) return { failures: assets.failures };
  log(`health ok; ${assets.assets} same-origin script and stylesheet asset(s) load`);
  return buildResult({ label, tag, commit, env, deploy: deployRecord(deployOutput).deploy, assets: assets.assets, observedAt: new Date(now()).toISOString() });
}

/** @param {string[]} args */
function parse(args) {
  const options = Object.create(null);
  for (let index = 0; index < args.length; index += 2) {
    if (!/^--[a-z-]+$/.test(args[index] ?? '') || index + 1 >= args.length) throw new Error(`unknown or incomplete option ${args[index]}`);
    options[args[index].slice(2)] = args[index + 1];
  }
  return options;
}

const seconds = (value, fallback) => {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d{0,4}$/.test(value)) throw new Error(`not a whole number of seconds: ${value}`);
  return Number(value) * 1000;
};

/**
 * @param {string[]} argv command and arguments
 * @param {{ out?: (line: string) => void, err?: (line: string) => void, fetch?: typeof globalThis.fetch,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number, env?: Record<string, string | undefined>,
 *   readFile?: (path: string) => string }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function run(argv, { out = console.log, err = console.error, env = process.env, readFile, ...poll } = {}) {
  const [command, ...rest] = argv;
  const report = (failures, ok) => {
    for (const failure of failures) err(`FAIL ${failure}`);
    if (!failures.length) out(ok);
    return failures.length ? 1 : 0;
  };
  let options;
  let request;
  try {
    options = parse(rest);
    hostFor(options.worker ?? '');
    const [required, optional] = Object.hasOwn(COMMANDS, command ?? '') ? COMMANDS[command] : [[], []];
    const valid = required.length && required.every((key) => key in options)
      && Object.keys(options).every((key) => required.includes(key) || optional.includes(key));
    const identity = !('tag' in options) || (TAG.test(options.tag) && COMMIT.test(options.commit));
    if (valid && identity) request = command;
    if (!request) throw new Error(`invalid ${command ?? 'command'} arguments`);
    options.timeoutMs = seconds(options.timeout, 300_000);
    options.intervalMs = seconds(options.interval, 10_000);
  } catch (error) {
    err(`${error.message}\n${USAGE}`);
    return 2;
  }
  const label = options.worker;
  if (request === 'host') {
    out(hostFor(label));
    return 0;
  }
  if (request === 'evidence') {
    const { failures, job } = await verifyEvidence({ tag: options.tag, commit: options.commit, env, fetch: poll.fetch, ...(readFile ? { readFile } : {}) });
    return report(failures, `${label}: caller job ${JSON.stringify(job)} reproduced ${options.tag} at ${options.commit} in this run attempt, and its Release is published`);
  }
  let deployOutput;
  let status;
  try {
    deployOutput = (readFile ?? ((path) => readFileSync(path, 'utf8')))(options['deploy-output']);
    status = JSON.parse((readFile ?? ((path) => readFileSync(path, 'utf8')))(options.status));
  } catch (error) {
    return report([`cannot read deploy evidence: ${error.message}`], '');
  }
  if (request === 'traffic') {
    return report(checkTraffic({ label, deployOutput, status }), `${label}: the deployed version serves 100% of traffic`);
  }
  const { failures, result } = await observe({
    label, tag: options.tag, commit: options.commit, deployOutput, status, env,
    timeoutMs: options.timeoutMs, intervalMs: options.intervalMs, log: out, ...poll,
  });
  if (result) writeFileSync(options.result, `${JSON.stringify(result)}\n`);
  return report(failures, `${label}: ${options.tag} at ${options.commit} serves 100% of traffic, reports its identity and health, and loads its assets`);
}

// realpath on both sides: a symlinked checkout path must still run, never silently exit 0.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await run(process.argv.slice(2));
}
