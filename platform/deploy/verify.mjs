#!/usr/bin/env node
// The post-deploy identity checks the reusable deploy-worker workflow runs from the consumer's vendored platform/:
//   node platform/deploy/verify.mjs host --worker <label>
//       print the Worker's declared public host
//   node platform/deploy/verify.mjs traffic --worker <label> --deploy-output <ndjson> --status <json>
//       the version wrangler just deployed serves 100% of traffic
//   node platform/deploy/verify.mjs version --worker <label> --version <X.Y.Z> --commit <sha> [--timeout <s>] [--interval <s>]
//       poll https://<host>/version.json until app, version and commit match; fail on timeout
// Exit codes: 0 verified, 1 not verified, 2 usage error. Only `version` reads the network, and only the public host.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DESIRED } from '../conformance/desired.mjs';

const USAGE = 'usage: verify.mjs host --worker <label> | traffic --worker <label> --deploy-output <ndjson> --status <json>'
  + ' | version --worker <label> --version <X.Y.Z> --commit <sha> [--timeout <s>] [--interval <s>]';
// Each command's required and optional options.
const COMMANDS = {
  host: [['worker'], []],
  traffic: [['worker', 'deploy-output', 'status'], []],
  version: [['worker', 'version', 'commit'], ['timeout', 'interval']],
};
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** @param {string} label */
export function hostFor(label) {
  const worker = Object.hasOwn(DESIRED.workers, label) ? DESIRED.workers[label] : null;
  if (!worker) throw new Error(`unknown Worker ${JSON.stringify(label)}`);
  return worker.host;
}

/**
 * The single deploy record wrangler wrote to WRANGLER_OUTPUT_FILE_PATH, and the Worker's current deployment
 * from `wrangler deployments status --json`, must name the same version at 100% of traffic.
 * @param {{ label: string, deployOutput: string, status: unknown }} input
 * @returns {string[]} failures
 */
export function checkTraffic({ label, deployOutput, status }) {
  const records = [];
  for (const [index, line] of deployOutput.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      return [`deploy output line ${index + 1} is not JSON`];
    }
  }
  const deploys = records.filter((record) => record?.type === 'deploy');
  if (deploys.length !== 1) return [`deploy output must hold exactly one deploy record; found ${deploys.length}`];
  const [deploy] = deploys;
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
 * Poll the public /version.json until it reports the expected identity.
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
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'error', cache: 'no-store', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      if (response.status !== 200) last = `HTTP ${response.status}`;
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
    if (now() + intervalMs > deadline) return [`${url} did not report ${version} at ${commit} before the timeout: ${last}`];
    await sleep(intervalMs);
  }
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
 *   sleep?: (ms: number) => Promise<void>, now?: () => number }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function run(argv, { out = console.log, err = console.error, ...poll } = {}) {
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
    if (valid && (command !== 'version' || (SEMVER.test(options.version) && COMMIT.test(options.commit)))) request = command;
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
  if (request === 'traffic') {
    let deployOutput;
    let status;
    try {
      deployOutput = readFileSync(options['deploy-output'], 'utf8');
      status = JSON.parse(readFileSync(options.status, 'utf8'));
    } catch (error) {
      return report([`cannot read deploy evidence: ${error.message}`], '');
    }
    return report(checkTraffic({ label, deployOutput, status }), `${label}: the deployed version serves 100% of traffic`);
  }
  const failures = await pollVersion({
    label, version: options.version, commit: options.commit, timeoutMs: options.timeoutMs, intervalMs: options.intervalMs, log: out, ...poll,
  });
  return report(failures, `${label}: /version.json reports ${options.version} at ${options.commit}`);
}

// realpath on both sides: a symlinked checkout path must still run, never silently exit 0.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await run(process.argv.slice(2));
}
