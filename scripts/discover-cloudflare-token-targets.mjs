#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCloudflareDesiredState, validateCloudflareDesiredState } from './cloudflare-desired-state.mjs';
import { SECRET_NAME, createGh, discoverTokenTargets, requireGhAuth } from './cloudflare-token-targets.mjs';

// Exit codes: 0 every declared target holds the secret with no drift, 1 drift, 2 usage, a missing gh or
// missing GitHub credentials, 3 denied or failed read access, 4 an invalid committed authority.
export const EXIT = Object.freeze({ ready: 0, drift: 1, usage: 2, readAccess: 3, failure: 4 });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const USAGE = `Usage: npm run discover:cloudflare-token-targets

Read-only. Lists the ${SECRET_NAME} targets declared in config/cloudflare.json (each Worker's repository and
its production environment) with the secret's updatedAt, then reports drift: a missing production environment
or secret, and any ${SECRET_NAME} at repository level or in another environment. Reads names and metadata only.`;

export function runDiscoverTokenTargets({ argv = process.argv.slice(2), env = process.env, root = ROOT, gh = createGh({ env }),
  log = console.log, error = console.error } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    log(USAGE);
    return EXIT.ready;
  }
  if (argv.length) {
    error(`error: unknown argument (not echoed)\n${USAGE}`);
    return EXIT.usage;
  }

  const desired = loadCloudflareDesiredState(root);
  const invalid = validateCloudflareDesiredState(desired);
  if (invalid.length) {
    error('config/cloudflare.json is not a valid desired state; nothing was read:');
    for (const entry of invalid) error(`- ${entry}`);
    return EXIT.failure;
  }

  let found;
  try {
    requireGhAuth(gh);
    found = discoverTokenTargets(desired, gh);
  } catch (failure) {
    if (failure.code === 'GH_MISSING' || failure.code === 'GH_CREDENTIALS') {
      error(`GitHub credentials: ${failure.message}`);
      return EXIT.usage;
    }
    error(`GitHub read access failed: ${failure.message}`);
    return EXIT.readAccess;
  }

  for (const { worker, repository, environment, updatedAt } of found.targets) {
    log(`${worker}\t${repository}\t${environment}\t${updatedAt ?? 'missing'}`);
  }
  if (!found.drift.length) return EXIT.ready;
  error(`Drift (${found.drift.length}):`);
  for (const entry of found.drift) error(`- ${entry}`);
  return EXIT.drift;
}

if (import.meta.main) process.exitCode = runDiscoverTokenTargets();
