// The /admin/* operator gate, lifted from SharkTank's fail-closed `opsAuthorized`
// (`src/worker/index.ts` at a031820). It accepts one credential, the shared WG_OPS_TOKEN.
// The loopback exception is gone: the host guard only admits declared public hosts.
import { isSecureRequest } from './http.mjs';

/** Basic auth carries a username; the shell accepts exactly this one. */
export const OPS_USERNAME = 'ops';

/**
 * Resolve a secret that is either a plain Worker secret or a Secrets Store binding (`{ get() }`).
 * Anything missing, empty or unreadable resolves to '' so callers fail closed.
 * @param {unknown} binding
 * @returns {Promise<string>}
 */
export async function readSecret(binding) {
  try {
    const value = typeof binding === 'string' ? binding
      : typeof /** @type {any} */ (binding)?.get === 'function' ? await /** @type {any} */ (binding).get() : '';
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/**
 * The session signing key, exposed for apps; the shell itself issues no sessions.
 * @param {{ WG_SESSION_KEY?: unknown }} env
 */
export function sessionKey(env) {
  return readSecret(env?.WG_SESSION_KEY);
}

/**
 * Constant-time compare over SHA-256 digests. Comparing the raw strings leaks the secret's
 * length through an early return; digests are always 32 bytes, so nothing is observable.
 * @param {string} a
 * @param {string} b
 */
export async function constantTimeEqual(a, b) {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Gate on the path an app router could end up matching: case-folded and percent-decoded, so
 * `/Admin/x` or `/%61dmin/x` cannot slip past the gate into a lenient router.
 * @param {string} path
 */
export function isAdminPath(path) {
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* a malformed escape keeps the raw path */ }
  return [path, decoded].some((candidate) => {
    const folded = candidate.toLowerCase();
    return folded === '/admin' || folded.startsWith('/admin/');
  });
}

/**
 * Operator authentication. Fails closed in every direction:
 *  - no WG_OPS_TOKEN  → 'unconfigured'
 *  - not over TLS     → 'insecure', because Basic auth is reversible base64
 *  - anything else that is not the exact Bearer token or ops:token Basic pair → 'denied'
 * @param {Request} request
 * @param {{ WG_OPS_TOKEN?: unknown }} env
 * @param {URL} url
 * @returns {Promise<'ok' | 'unconfigured' | 'insecure' | 'denied'>}
 */
export async function opsAuthorization(request, env, url) {
  const token = await readSecret(env?.WG_OPS_TOKEN);
  if (!token) return 'unconfigured';
  if (!isSecureRequest(request, url)) return 'insecure';
  const auth = request.headers.get('authorization') ?? '';
  if (auth.startsWith('Bearer ')) return (await constantTimeEqual(auth.slice(7), token)) ? 'ok' : 'denied';
  if (auth.startsWith('Basic ')) {
    let decoded;
    try { decoded = atob(auth.slice(6)); } catch { return 'denied'; }
    const separator = decoded.indexOf(':');
    if (separator < 0) return 'denied';
    const [userOk, passOk] = await Promise.all([
      constantTimeEqual(decoded.slice(0, separator), OPS_USERNAME),
      constantTimeEqual(decoded.slice(separator + 1), token),
    ]);
    return userOk && passOk ? 'ok' : 'denied';
  }
  return 'denied';
}
