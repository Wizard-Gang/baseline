import { spawnSync } from 'node:child_process';
import { ENVIRONMENT } from './cloudflare-desired-state.mjs';

// The one GitHub secret this tooling manages: the deploy token deploy-worker.yml reads from a caller's
// `production` environment. Targets come only from config/cloudflare.json; nothing is discovered by listing owners.
export const SECRET_NAME = 'CLOUDFLARE_API_TOKEN';

export class GhError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** One write target per declared Worker: its repository's `production` environment secret. */
export function declaredTokenTargets(desired) {
  const targets = Object.entries(desired.workers)
    .map(([worker, { repository, environment }]) => ({ worker, repository, environment }))
    .filter((target) => target.environment === ENVIRONMENT);
  const seen = new Set();
  return targets.filter(({ repository, environment }) => {
    const key = `${repository}\t${environment}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Runs the GitHub CLI without a shell. A value is only ever passed as `input` (stdin), never as an argument.
export function createGh({ env = process.env, spawn = spawnSync } = {}) {
  return (args, { input = '' } = {}) => {
    const result = spawn('gh', args, { env, input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.error?.code === 'ENOENT') throw new GhError('GH_MISSING', 'the GitHub CLI (gh) is not installed or not on PATH');
    if (result.error) throw new GhError('GH_FAILED', `gh could not run: ${result.error.message}`);
    return { status: result.status, stdout: result.stdout ?? '', stderr: (result.stderr ?? '').trim() };
  };
}

export function requireGhAuth(gh) {
  const { status } = gh(['auth', 'status']);
  if (status !== 0) throw new GhError('GH_CREDENTIALS', 'gh is not authenticated; run gh auth login or supply GH_TOKEN at runtime');
}

function readJson(gh, args, what) {
  const { status, stdout, stderr } = gh(args);
  if (status !== 0) throw new GhError('GH_READ', `cannot read ${what}${stderr ? `: ${stderr.split('\n')[0]}` : ''}`);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new GhError('GH_READ', `gh returned malformed JSON for ${what}`);
  }
}

/** The `updatedAt` of SECRET_NAME at a repository (no environment) or environment scope, or null when absent. */
export function readSecretUpdatedAt(gh, repository, environment = null) {
  const scope = environment ? ['--env', environment] : [];
  const what = environment ? `${environment} environment secrets of ${repository}` : `repository secrets of ${repository}`;
  const secrets = readJson(gh, ['secret', 'list', '--repo', repository, ...scope, '--json', 'name,updatedAt'], what);
  if (!Array.isArray(secrets)) throw new GhError('GH_READ', `gh returned a non-list for ${what}`);
  const secret = secrets.find((entry) => entry?.name === SECRET_NAME);
  if (!secret) return null;
  if (typeof secret.updatedAt !== 'string' || Number.isNaN(Date.parse(secret.updatedAt))) {
    throw new GhError('GH_READ', `${what} report ${SECRET_NAME} without a valid updatedAt`);
  }
  return secret.updatedAt;
}

function readEnvironments(gh, repository) {
  const body = readJson(gh, ['api', `repos/${repository}/environments`], `environments of ${repository}`);
  if (!Array.isArray(body?.environments)) throw new GhError('GH_READ', `gh returned no environment list for ${repository}`);
  return body.environments.map((entry) => entry?.name).filter((name) => typeof name === 'string').sort();
}

/**
 * Reads secret metadata (names and updatedAt only, never values) for every declared target.
 * Returns each target's state and the drift: a missing production environment or secret, and any
 * SECRET_NAME held at repository level or in another environment. Drift is reported, never written.
 */
export function discoverTokenTargets(desired, gh) {
  const targets = [];
  const drift = [];
  for (const target of declaredTokenTargets(desired)) {
    const { repository, environment } = target;
    if (readSecretUpdatedAt(gh, repository) !== null) {
      drift.push(`${repository}: repository-level ${SECRET_NAME} is outside the ${environment} environment; it is reported and never updated`);
    }
    const environments = readEnvironments(gh, repository);
    const environmentExists = environments.includes(environment);
    const updatedAt = environmentExists ? readSecretUpdatedAt(gh, repository, environment) : null;
    if (!environmentExists) drift.push(`${repository}: the ${environment} environment does not exist`);
    else if (updatedAt === null) drift.push(`${repository}: the ${environment} environment has no ${SECRET_NAME}`);
    for (const other of environments.filter((name) => name !== environment)) {
      if (readSecretUpdatedAt(gh, repository, other) !== null) {
        drift.push(`${repository}: the ${other} environment holds ${SECRET_NAME}; only ${environment} is a target, so it is never updated`);
      }
    }
    targets.push({ ...target, environmentExists, updatedAt });
  }
  return { targets, drift };
}

/** Defence in depth: removes a secret value from any text before it is printed. */
export function redactor(value) {
  return (text) => (value ? String(text).split(value).join('[redacted]') : String(text));
}
