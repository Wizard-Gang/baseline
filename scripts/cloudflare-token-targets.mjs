import { spawnSync } from 'node:child_process';
import { loadCloudflareDesiredState, validateCloudflareDesiredState } from './cloudflare-desired-state.mjs';
import { loadSecretRegistry, validateSecretRegistryAt } from './secret-registry.mjs';

// GitHub secret and variable targets come only from config/secrets.json: its `github-environment` entries and
// exceptions, in the repositories of config/cloudflare.json. Nothing is discovered by listing owners.
export const HOME = 'github-environment';
// Rotation writes Cloudflare credentials only: the tool checks each value against the Cloudflare API.
export const ROTATABLE_PROVIDER = 'cloudflare';
const KINDS = Object.freeze(['secret', 'variable']);

export class GhError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Loads and validates both authorities; returns failures instead of throwing on a missing or malformed file. */
export function loadAuthorities(root) {
  try {
    const desired = loadCloudflareDesiredState(root);
    const failures = [
      ...validateCloudflareDesiredState(desired).map((failure) => `config/cloudflare.json: ${failure}`),
      ...validateSecretRegistryAt(root).map((failure) => `config/secrets.json: ${failure}`),
    ];
    return { desired, registry: loadSecretRegistry(root), failures };
  } catch (failure) {
    return { failures: [`cannot read the committed authorities: ${failure.message}`] };
  }
}

/** The config repositories, in config/cloudflare.json order. */
export function configRepositories(desired) {
  return [...new Set(Object.values(desired.workers).map((worker) => worker.repository))];
}

const consumerParts = (consumer) => {
  const at = consumer.lastIndexOf(':');
  return { repository: consumer.slice(0, at), environment: consumer.slice(at + 1) };
};

/**
 * Every registered GitHub-environment secret and variable as { repository, environment, kind, name, provider,
 * credential }, with each exception's console credential replacing the entry's for its one consumer.
 */
export function registryTargets(registry, repositories) {
  const targets = [];
  for (const entry of registry.entries.filter((candidate) => candidate.home === HOME && KINDS.includes(candidate.kind))) {
    for (const consumer of entry.consumers) {
      const exception = registry.exceptions.find((candidate) => candidate.home === HOME
        && candidate.name === entry.name && candidate.consumer === consumer);
      const { kind, name, provider } = entry;
      targets.push({ ...consumerParts(consumer), kind, name, provider, credential: exception?.credential ?? entry.credential });
    }
  }
  const order = (target) => [repositories.indexOf(target.repository), target.environment, KINDS.indexOf(target.kind), target.name];
  return targets.sort((a, b) => {
    const [left, right] = [order(a), order(b)];
    const at = left.findIndex((value, index) => value !== right[index]);
    return at < 0 ? 0 : left[at] < right[at] ? -1 : 1;
  });
}

/** Console credentials that rotation accepts: Cloudflare secrets with at least one GitHub-environment target. */
export function rotatableCredentials(registry) {
  return [...new Set(registryTargets(registry, []).filter((target) => target.kind === 'secret'
    && target.provider === ROTATABLE_PROVIDER && typeof target.credential === 'string').map((target) => target.credential))].sort();
}

/** The GitHub-environment secrets mapped to one console credential, or null when it is not rotatable. */
export function credentialTargets(registry, repositories, credential) {
  if (!rotatableCredentials(registry).includes(credential)) return null;
  return registryTargets(registry, repositories).filter((target) => target.kind === 'secret' && target.credential === credential);
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

/** Names and updatedAt of the secrets or variables at a repository (no environment) or environment scope; never values. */
export function listNames(gh, kind, repository, environment = null) {
  const scope = environment ? ['--env', environment] : [];
  const what = `${environment ? `${environment} environment` : 'repository'} ${kind}s of ${repository}`;
  const listed = readJson(gh, [kind, 'list', '--repo', repository, ...scope, '--json', 'name,updatedAt'], what);
  if (!Array.isArray(listed)) throw new GhError('GH_READ', `gh returned a non-list for ${what}`);
  const names = new Map();
  for (const { name, updatedAt } of listed) {
    if (typeof name !== 'string' || typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) {
      throw new GhError('GH_READ', `${what} include an entry without a valid name and updatedAt`);
    }
    names.set(name, updatedAt);
  }
  return names;
}

export const readSecretUpdatedAt = (gh, name, repository, environment) => listNames(gh, 'secret', repository, environment).get(name) ?? null;

function readEnvironments(gh, repository) {
  const body = readJson(gh, ['api', `repos/${repository}/environments`], `environments of ${repository}`);
  if (!Array.isArray(body?.environments)) throw new GhError('GH_READ', `gh returned no environment list for ${repository}`);
  return body.environments.map((entry) => entry?.name).filter((name) => typeof name === 'string').sort();
}

const other = (kind) => (kind === 'secret' ? 'variable' : 'secret');

function compareEnvironment(repository, environment, expected, listed, drift) {
  const where = `${repository}: the ${environment} environment`;
  for (const target of expected) {
    const misplaced = listed[other(target.kind)].has(target.name);
    target.updatedAt = listed[target.kind].get(target.name) ?? null;
    if (target.updatedAt !== null) continue;
    drift.push(misplaced
      ? `${where} stores ${target.name} as a ${other(target.kind)}; the registry makes it a ${target.kind}`
      : `${where} has no registered ${target.kind} ${target.name}`);
  }
  for (const kind of KINDS) {
    for (const name of listed[kind].keys()) {
      const target = expected.find((candidate) => candidate.name === name);
      if (target?.kind === kind || (target && target.updatedAt === null)) continue;
      if (target) {
        drift.push(`${where} also holds ${name} as a ${kind}; the registry makes it a ${target.kind}, so delete the ${kind}`);
        continue;
      }
      drift.push(expected.length ? `${where} holds ${kind} ${name}, which is not in the registry`
        : `${where} is not a registry environment but holds ${kind} ${name}; it is reported and never updated`);
    }
  }
}

/**
 * Reads names and updatedAt only for every config repository: repository-level secrets and variables, every
 * environment, and each environment's secrets and variables. Returns each registry target with its updatedAt
 * (null when absent) and the drift: anything outside the registry, a missing environment or entry, or an entry
 * stored as the wrong kind. Drift is reported, never written.
 */
export function discoverRegistryTargets({ desired, registry }, gh) {
  const repositories = configRepositories(desired);
  const targets = registryTargets(registry, repositories).map((target) => ({ ...target, environmentExists: false, updatedAt: null }));
  const drift = [];
  for (const repository of repositories) {
    for (const kind of KINDS) {
      for (const name of listNames(gh, kind, repository).keys()) {
        drift.push(`${repository}: repository-level ${kind} ${name} is outside the registry; it is reported and never updated`);
      }
    }
    const environments = readEnvironments(gh, repository);
    const mine = targets.filter((target) => target.repository === repository);
    for (const environment of [...new Set([...environments, ...mine.map((target) => target.environment)])].sort()) {
      const expected = mine.filter((target) => target.environment === environment);
      if (!environments.includes(environment)) {
        drift.push(`${repository}: the ${environment} environment does not exist`);
        continue;
      }
      for (const target of expected) target.environmentExists = true;
      const listed = Object.fromEntries(KINDS.map((kind) => [kind, listNames(gh, kind, repository, environment)]));
      compareEnvironment(repository, environment, expected, listed, drift);
    }
  }
  return { targets, drift };
}

/** Defence in depth: removes a secret value from any text before it is printed. */
export function redactor(value) {
  return (text) => (value ? String(text).split(value).join('[redacted]') : String(text));
}
