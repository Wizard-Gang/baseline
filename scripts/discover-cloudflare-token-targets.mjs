#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGh, discoverRegistryTargets, loadAuthorities, requireGhAuth } from './cloudflare-token-targets.mjs';

// Exit codes: 0 every registry target is present with no drift, 1 drift, 2 usage, a missing gh or missing GitHub
// credentials, 3 denied or failed read access, 4 an invalid committed authority.
export const EXIT = Object.freeze({ ready: 0, drift: 1, usage: 2, readAccess: 3, failure: 4 });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const USAGE = `Usage: npm run discover:cloudflare-token-targets

Read-only. Lists every GitHub-environment secret and variable that config/secrets.json registers for the
repositories in config/cloudflare.json, one line each:
  <repository> <environment> <secret|variable> <name> <console credential or -> <updatedAt or missing>
then reports drift: repository-level secrets or variables, another environment, a name outside the registry,
a missing environment or registered entry, and a registered entry stored as the other kind (a variable held as a
secret). Reads names and updatedAt only, never a value.`;

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

  const authorities = loadAuthorities(root);
  if (authorities.failures.length) {
    error('The committed authorities are invalid; nothing was read:');
    for (const entry of authorities.failures) error(`- ${entry}`);
    return EXIT.failure;
  }

  let found;
  try {
    requireGhAuth(gh);
    found = discoverRegistryTargets(authorities, gh);
  } catch (failure) {
    if (failure.code === 'GH_MISSING' || failure.code === 'GH_CREDENTIALS') {
      error(`GitHub credentials: ${failure.message}`);
      return EXIT.usage;
    }
    error(`GitHub read access failed: ${failure.message}`);
    return EXIT.readAccess;
  }

  for (const { repository, environment, kind, name, credential, updatedAt } of found.targets) {
    log([repository, environment, kind, name, credential ?? '-', updatedAt ?? 'missing'].join('\t'));
  }
  if (!found.drift.length) return EXIT.ready;
  error(`Drift (${found.drift.length}):`);
  for (const entry of found.drift) error(`- ${entry}`);
  return EXIT.drift;
}

if (import.meta.main) process.exitCode = runDiscoverTokenTargets();
