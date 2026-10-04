#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GhError, configRepositories, createGh, credentialTargets, discoverRegistryTargets, loadAuthorities, readSecretUpdatedAt,
  redactor, requireGhAuth, rotatableCredentials } from './cloudflare-token-targets.mjs';

// Exit codes: 0 planned (no --apply) or every target rotated and re-read, 1 a write or its re-read failed,
// 2 usage (including a missing, unknown or non-rotatable --credential), a missing gh or GitHub credentials, or a
// missing or malformed value on stdin, 3 denied or failed read access before any write, 4 an invalid authority,
// a missing target environment or a token Cloudflare rejects.
export const EXIT = Object.freeze({ rotated: 0, writeFailed: 1, usage: 2, readAccess: 3, failure: 4 });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
// Printable ASCII with no whitespace; one trailing newline from a pipe is removed first.
const TOKEN_SHAPE = /^[\x21-\x7e]{20,512}$/;

export const USAGE = `Usage: npm run rotate:cloudflare-token -- --credential <console name> [--apply [--skip-verify]]

The console credential (wg-cloudflare-deploy or wg-cloudflare-demo) selects the targets: only the GitHub
environment secrets that config/secrets.json maps to it, including a registry exception. Without --apply, prints
those targets and the registry drift and changes nothing.
With --apply, reads the new token from stdin (piped, never a terminal or an argument), checks that Cloudflare
reports it active, writes it to each mapped environment with gh secret set over stdin, and re-reads the secret's
updatedAt after each write. Every other secret, environment and repository-level copy is never written.
CLOUDFLARE_ACCOUNT_ID, when set, verifies an account-owned token.

  pbpaste | npm run rotate:cloudflare-token -- --credential wg-cloudflare-deploy --apply`;

/** { credential, apply, skipVerify } or { problem } for anything else; arguments are never echoed. */
export function parseArguments(argv) {
  const options = { credential: null, apply: false, skipVerify: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--skip-verify') options.skipVerify = true;
    else if (arg === '--credential' && options.credential === null && index + 1 < argv.length) options.credential = argv[++index];
    else return { problem: 'unknown or repeated argument (not echoed); the token is read from stdin only' };
  }
  if (options.credential === null) return { problem: '--credential <console name> is required' };
  if (options.skipVerify && !options.apply) return { problem: '--skip-verify needs --apply' };
  return options;
}

async function readValue(stdin) {
  if (stdin.isTTY) throw new GhError('VALUE', 'pipe the token on stdin; a terminal would echo it');
  let text = '';
  for await (const chunk of stdin) text += chunk;
  const value = text.replace(/\r?\n$/, '');
  if (!TOKEN_SHAPE.test(value)) throw new GhError('VALUE', 'stdin must hold exactly one token: 20-512 printable characters, no whitespace');
  return value;
}

async function cloudflareReportsActive(value, accountId, fetchImpl) {
  const path = accountId ? `/accounts/${encodeURIComponent(accountId)}/tokens/verify` : '/user/tokens/verify';
  try {
    const response = await fetchImpl(`${CLOUDFLARE_API}${path}`, { method: 'GET', headers: { Authorization: `Bearer ${value}` } });
    const body = await response.json();
    return response.ok && body?.success === true && body?.result?.status === 'active';
  } catch {
    return false;
  }
}

export async function runRotateCloudflareToken({ argv = process.argv.slice(2), env = process.env, root = ROOT,
  gh = createGh({ env }), stdin = process.stdin, fetchImpl = fetch, log = console.log, error = console.error } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    log(USAGE);
    return EXIT.rotated;
  }
  const options = parseArguments(argv);
  if (options.problem) {
    // A token pasted into argv must not reach the output.
    error(`error: ${options.problem}\n${USAGE}`);
    return EXIT.usage;
  }
  const { apply, credential } = options;

  const authorities = loadAuthorities(root);
  if (authorities.failures.length) {
    error('The committed authorities are invalid; nothing was read or written:');
    for (const entry of authorities.failures) error(`- ${entry}`);
    return EXIT.failure;
  }
  const targets = credentialTargets(authorities.registry, configRepositories(authorities.desired), credential);
  if (!targets?.length) {
    error(`error: --credential must name a Cloudflare console credential with a GitHub environment target in config/secrets.json `
      + `(not echoed); one of ${rotatableCredentials(authorities.registry).join(', ')}. Nothing was read or written.`);
    return EXIT.usage;
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
    error(`GitHub read access failed before any write: ${failure.message}`);
    return EXIT.readAccess;
  }
  const mapped = found.targets.filter((target) => targets.some((wanted) => wanted.repository === target.repository
    && wanted.environment === target.environment && wanted.kind === target.kind && wanted.name === target.name));

  log(`Targets for ${credential} (GitHub environment secrets config/secrets.json maps to it):`);
  for (const { repository, environment, name, updatedAt } of mapped) {
    log(`- ${repository} — ${environment} environment ${name} (updatedAt ${updatedAt ?? 'none'})`);
  }
  if (found.drift.length) {
    error(`Registry drift, reported and never written (${found.drift.length}):`);
    for (const entry of found.drift) error(`- ${entry}`);
  }
  const missing = mapped.filter((target) => !target.environmentExists);
  if (missing.length) {
    error(`error: create ${missing.map((target) => `the ${target.environment} environment in ${target.repository}`).join(', ')} first; nothing was written`);
    return EXIT.failure;
  }
  if (!apply) {
    log('Plan only; nothing was read from stdin or written. Pipe the token in with --apply to rotate.');
    return EXIT.rotated;
  }

  let value;
  try {
    value = await readValue(stdin);
  } catch (failure) {
    error(`error: ${failure.message}; nothing was written`);
    return EXIT.usage;
  }
  const redact = redactor(value);
  const say = (text) => log(redact(text));
  const warn = (text) => error(redact(text));

  if (argv.includes('--skip-verify')) {
    say('Skipping the Cloudflare token check (--skip-verify).');
  } else if (!(await cloudflareReportsActive(value, env.CLOUDFLARE_ACCOUNT_ID, fetchImpl))) {
    warn('error: Cloudflare did not report the token as active; nothing was written');
    return EXIT.failure;
  } else {
    say('Cloudflare reports the token as active.');
  }

  let failures = 0;
  for (const { repository, environment, name, updatedAt: before } of mapped) {
    const where = `${repository} — ${environment} environment ${name}`;
    const written = gh(['secret', 'set', name, '--repo', repository, '--env', environment], { input: value });
    if (written.status !== 0) {
      warn(`error: write failed for ${where}${written.stderr ? `: ${written.stderr.split('\n')[0]}` : ''}`);
      failures += 1;
      continue;
    }
    let after;
    try {
      after = readSecretUpdatedAt(gh, name, repository, environment);
    } catch (failure) {
      warn(`error: re-read failed for ${where}: ${failure.message}`);
      failures += 1;
      continue;
    }
    if (after === null || (before !== null && Date.parse(after) <= Date.parse(before))) {
      warn(`error: re-read of ${where} shows no new updatedAt (before ${before ?? 'none'}, after ${after ?? 'none'})`);
      failures += 1;
      continue;
    }
    say(`Updated ${where}: updatedAt ${after}`);
  }
  if (failures) {
    warn(`Rotation finished with ${failures} failure(s); correct access and re-run.`);
    return EXIT.writeFailed;
  }
  say(`Rotation of ${credential} complete for all ${mapped.length} target(s).`);
  return EXIT.rotated;
}

if (import.meta.main) process.exitCode = await runRotateCloudflareToken();
