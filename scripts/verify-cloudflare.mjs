#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCloudflareDesiredState, validateCloudflareDesiredState } from './cloudflare-desired-state.mjs';
import { compareCloudflareState, expectedCloudflareState, hasDrift } from './cloudflare-drift.mjs';
import { fetchLiveCloudflareState, requireCredentials } from './cloudflare-live-state.mjs';

// Exit codes: 0 converged, 1 drift, 2 missing or malformed credentials, 3 read access denied,
// 4 an invalid committed authority or any other Cloudflare API failure.
export const EXIT = Object.freeze({ converged: 0, drift: 1, credentials: 2, readAccess: 3, failure: 4 });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function runVerifyCloudflare({ env = process.env, fetchImpl = fetch, root = ROOT, log = console.log, error = console.error } = {}) {
  const token = env.CLOUDFLARE_API_TOKEN ?? '';
  // Defence in depth: no message is expected to contain the token, but none can leave this function with it.
  const redact = (text) => (token ? String(text).split(token).join('[redacted]') : String(text));
  const say = (text) => log(redact(text));
  const warn = (text) => error(redact(text));

  const desired = loadCloudflareDesiredState(root);
  const invalid = validateCloudflareDesiredState(desired);
  if (invalid.length) {
    warn('config/cloudflare.json is not a valid desired state; nothing was read:');
    for (const entry of invalid) warn(`- ${entry}`);
    return EXIT.failure;
  }

  let actual;
  try {
    const credentials = requireCredentials(env);
    actual = await fetchLiveCloudflareState(desired, { ...credentials, fetchImpl });
  } catch (failure) {
    if (failure.code === 'CLOUDFLARE_CREDENTIALS_REQUIRED') {
      warn(`Missing Cloudflare credentials: ${failure.message}`);
      return EXIT.credentials;
    }
    if (failure.code === 'CLOUDFLARE_READ_INACCESSIBLE') {
      warn(`Cloudflare read access failed: ${failure.message}`);
      warn('Use the read-only audit token with account read access to Workers, D1, R2, KV and Secrets Store.');
      return EXIT.readAccess;
    }
    warn(`Cloudflare read failed: ${failure.message}`);
    return EXIT.failure;
  }

  const drift = compareCloudflareState(expectedCloudflareState(desired), actual);
  if (!hasDrift(drift)) {
    say('Cloudflare matches config/cloudflare.json.');
    return EXIT.converged;
  }
  warn('Cloudflare does not match config/cloudflare.json:');
  for (const [heading, entries] of [['Missing', drift.missing], ['Unexpected', drift.unexpected], ['Mismatched', drift.mismatched]]) {
    if (!entries.length) continue;
    warn(`${heading} (${entries.length}):`);
    for (const entry of entries) warn(`- ${entry}`);
  }
  return EXIT.drift;
}

if (import.meta.main) process.exitCode = await runVerifyCloudflare();
