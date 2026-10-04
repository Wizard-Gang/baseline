// GitHub App installation tokens, signed inside the Worker with WebCrypto. The binding names are mirrored from baseline
// config/secrets.json: the GITHUB_APP_ID variable and the GITHUB_APP_PRIVATE_KEY Worker secret of the wg-github-app
// credential. The shell is vendored without that file, so the names are code; a baseline test ties them to the registry.
// Every failure is a GitHubAppError with a fixed message: no key, JWT, token or response body ever reaches an error or log.
import { readSecret } from './auth.mjs';

export const GITHUB_APP = Object.freeze({
  id: 'GITHUB_APP_ID',
  privateKey: 'GITHUB_APP_PRIVATE_KEY',
  credential: 'wg-github-app',
  consumers: Object.freeze(['demo']),
});

const API = 'https://api.github.com';
const JWT_BACKDATE_SECONDS = 60; // tolerate clock skew with GitHub
const JWT_LIFETIME_SECONDS = 540; // exp is 9 minutes ahead; GitHub refuses more than 10
const REFRESH_MS = 5 * 60_000; // a cached token is replaced once it has less than 5 minutes left
const LEVELS = Object.freeze({ read: 1, write: 2, admin: 3 });
// Matched after whitespace is removed, so the armour reads without its spaces.
const PKCS8 = /^-----BEGINPRIVATEKEY-----([A-Za-z0-9+/=]+)-----ENDPRIVATEKEY-----$/;
const defaultCache = new Map();

export class GitHubAppError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GitHubAppError';
  }
}

/** @param {unknown} value */
function appIdOf(value) {
  const id = typeof value === 'number' ? String(value) : value;
  if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id)) throw new GitHubAppError('GITHUB_APP_ID must be the numeric App ID');
  return id;
}

/** @param {unknown} value */
function installationOf(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id)) throw new GitHubAppError('installationId must be a positive integer');
  return id;
}

// Least privilege is mandatory: a request must name each permission it needs, and the canonical (sorted) set keys the cache.
/** @param {unknown} value @returns {Record<string, 'read' | 'write' | 'admin'>} */
function permissionsOf(value) {
  const entries = value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
  if (!entries.length) throw new GitHubAppError('permissions must name at least one permission');
  for (const [name, level] of entries) {
    if (!/^[a-z][a-z_]{0,63}$/.test(name) || !Object.hasOwn(LEVELS, level)) {
      throw new GitHubAppError('each permission must be a lower-case name set to read, write or admin');
    }
  }
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1)));
}

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodeJson = (value) => base64url(new TextEncoder().encode(JSON.stringify(value)));

/** @param {string} pem */
async function importPrivateKey(pem) {
  if (!pem) throw new GitHubAppError('GITHUB_APP_PRIVATE_KEY is not configured');
  // Literal \n escapes and line breaks are both accepted, so the key survives being pasted into a one-line secret field.
  const compact = pem.replace(/\\n/g, '').replace(/\s+/g, '');
  if (compact.startsWith('-----BEGINRSAPRIVATEKEY-----')) {
    throw new GitHubAppError('GITHUB_APP_PRIVATE_KEY must be PKCS#8 (BEGIN PRIVATE KEY); convert the downloaded PKCS#1 key first');
  }
  const body = PKCS8.exec(compact);
  let key;
  try {
    if (!body) throw new Error();
    const der = Uint8Array.from(atob(body[1]), (char) => char.charCodeAt(0));
    key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    throw new GitHubAppError('GITHUB_APP_PRIVATE_KEY is not a PKCS#8 RSA private key');
  }
  if (/** @type {any} */ (key.algorithm).modulusLength < 2048) throw new GitHubAppError('GITHUB_APP_PRIVATE_KEY must be at least 2048 bits');
  return key;
}

/**
 * The RS256 app JWT: iat backdated for clock skew, exp under GitHub's 10-minute ceiling, iss the App ID.
 * @param {CryptoKey} key @param {string} appId @param {number} nowMs
 */
async function signAppJwt(key, appId, nowMs) {
  const now = Math.floor(nowMs / 1000);
  const input = `${encodeJson({ alg: 'RS256', typ: 'JWT' })}.${encodeJson({ iat: now - JWT_BACKDATE_SECONDS, exp: now + JWT_LIFETIME_SECONDS, iss: appId })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

async function exchange(env, appId, installation, permissions, doFetch, now) {
  const key = await importPrivateKey(await readSecret(env?.[GITHUB_APP.privateKey]));
  const jwt = await signAppJwt(key, appId, now());
  let response;
  try {
    response = await doFetch(`${API}/app/installations/${installation}/access_tokens`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
        'user-agent': 'wizardgang-wg-edge',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ permissions }),
    });
  } catch {
    throw new GitHubAppError('GitHub App token exchange could not reach GitHub');
  }
  const status = Number.isInteger(response?.status) ? response.status : 0;
  if (status !== 201) throw new GitHubAppError(`GitHub App token exchange was refused (HTTP ${status})`);
  let body;
  try { body = await response.json(); } catch { body = null; }
  const token = body?.token;
  const expiresAt = typeof body?.expires_at === 'string' ? Date.parse(body.expires_at) : Number.NaN;
  if (typeof token !== 'string' || !/^[\x21-\x7e]{20,1024}$/.test(token) || !Number.isFinite(expiresAt) || expiresAt <= now()) {
    throw new GitHubAppError('GitHub App token exchange returned an unexpected response');
  }
  for (const [name, level] of Object.entries(permissions)) {
    if (!(LEVELS[body.permissions?.[name]] >= LEVELS[level])) {
      throw new GitHubAppError('GitHub App installation token lacks a requested permission');
    }
  }
  return { token, expiresAt };
}

/**
 * An installation token holding exactly the requested permissions, cached per App, installation and permission set
 * until less than five minutes of its life remain. Concurrent callers share one exchange.
 * @param {Record<string, unknown>} env
 * @param {{ installationId: number | string, permissions: Record<string, 'read' | 'write' | 'admin'> }} request
 * @param {{ fetch?: typeof fetch, now?: () => number, cache?: Map<string, Promise<{ token: string, expiresAt: number }>> }} [options]
 * @returns {Promise<string>}
 */
export async function githubAppToken(env, request, options = {}) {
  const { fetch: doFetch = globalThis.fetch, now = Date.now, cache = defaultCache } = options;
  const installation = installationOf(request?.installationId);
  const permissions = permissionsOf(request?.permissions);
  const appId = appIdOf(env?.[GITHUB_APP.id]);
  const cacheKey = `${appId}:${installation}:${JSON.stringify(permissions)}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    const entry = await cached;
    if (entry.expiresAt - now() > REFRESH_MS) return entry.token;
    if (cache.get(cacheKey) === cached) cache.delete(cacheKey);
  }
  const pending = exchange(env, appId, installation, permissions, doFetch, now);
  cache.set(cacheKey, pending);
  pending.catch(() => { if (cache.get(cacheKey) === pending) cache.delete(cacheKey); });
  return (await pending).token;
}
