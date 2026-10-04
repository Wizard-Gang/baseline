// Per-purpose app keys derived from the shared WG_SESSION_KEY with HKDF-SHA256, so no Worker holds its own signing
// secrets. The labels and their consumers are mirrored from baseline config/secrets.json (its `derived` entries). The
// shell is vendored without that file, so the table is code; a baseline test fails if the two ever disagree.
import { readSecret } from './auth.mjs';
import { ConfigurationError, workerIdentity } from './workers.mjs';

/** @type {Readonly<Record<string, Readonly<{ consumers: readonly string[] }>>>} */
export const DERIVED_KEYS = Object.freeze({
  'demo-session': Object.freeze({ consumers: Object.freeze(['demo']) }),
  'identity-session': Object.freeze({ consumers: Object.freeze(['demo']) }),
  'identity-audit': Object.freeze({ consumers: Object.freeze(['demo']) }),
});

// Fixed domain separation. Changing either value rotates every derived key, which signs every session out.
const SALT = new TextEncoder().encode('wizardgang wg-edge derived key v1');
const INFO_PREFIX = 'wg-edge:';
const KEY_BYTES = 32;

/**
 * 32 bytes of key material for one registry label, derived from WG_SESSION_KEY. The same root and label always give
 * the same bytes; different labels give unrelated bytes. Fails closed with a ConfigurationError, which carries no key
 * material, when the label is not declared, the Worker is not one of its consumers or WG_SESSION_KEY is missing or empty.
 * @param {{ WG_APP?: unknown, WG_SESSION_KEY?: unknown }} env
 * @param {string} label
 * @returns {Promise<Uint8Array>}
 */
export async function deriveKey(env, label) {
  if (typeof label !== 'string' || !Object.hasOwn(DERIVED_KEYS, label)) {
    throw new ConfigurationError('the derived key label is not declared in the secret registry');
  }
  const { app } = workerIdentity(env);
  if (!DERIVED_KEYS[label].consumers.includes(app)) {
    throw new ConfigurationError('this Worker is not a consumer of the derived key');
  }
  const root = await readSecret(env?.WG_SESSION_KEY);
  if (!root) throw new ConfigurationError('WG_SESSION_KEY is not configured');
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(root), 'HKDF', false, ['deriveBits']);
  const info = new TextEncoder().encode(`${INFO_PREFIX}${label}`);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info }, material, KEY_BYTES * 8);
  return new Uint8Array(bits);
}
