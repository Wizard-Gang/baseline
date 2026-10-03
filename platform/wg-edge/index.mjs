// wg-edge: the shared Worker shell. It wraps an app's fetch and scheduled handlers with the host guard,
// TLS rule, built-in /version.json, /health.json and /robots.txt, the /admin/* operator gate, security
// headers, Accept-driven 404s, an error boundary that never returns internals, and structured logs.
import { isAdminPath, opsAuthorization } from './auth.mjs';
import { isSecureRequest, json, notFound, problem, redirect, text, withSecurityHeaders } from './http.mjs';
import { createLogger } from './log.mjs';
import { ConfigurationError, WORKERS, classifyHost, workerIdentity } from './workers.mjs';

export { OPS_USERNAME, constantTimeEqual, readSecret, sessionKey } from './auth.mjs';
export { SECURITY_HEADERS, json, notFound, problem, text, wantsHtml } from './http.mjs';
export { createLogger } from './log.mjs';
export { bucket, events, records, sweepExpired } from './storage.mjs';
export { ConfigurationError, WORKERS, workerIdentity } from './workers.mjs';

export const DEFAULT_ROBOTS = 'User-agent: *\nDisallow: /admin/\n';
const BUILT_IN = new Set(['/version.json', '/health.json', '/robots.txt']);
const READ_METHODS = new Set(['GET', 'HEAD']);

/** @param {unknown} env */
function logName(env) {
  const app = /** @type {any} */ (env)?.WG_APP;
  return typeof app === 'string' && Object.hasOwn(WORKERS, app) ? app : 'unconfigured';
}

/** @param {any} release */
function checkRelease(release) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release?.version ?? '') || !/^[0-9a-f]{40}$/.test(release?.commit ?? '')) {
    throw new ConfigurationError('release must carry a semantic version and a full 40-character commit');
  }
  return Object.freeze({ version: release.version, commit: release.commit });
}

/**
 * @param {import('./index.d.ts').EdgeOptions} options
 * @returns {import('./index.d.ts').EdgeHandler}
 */
export function createEdge(options) {
  const release = checkRelease(options?.release);
  const { fetch: appFetch, scheduled: appScheduled, health, logSink } = options;
  const robots = options.robots ?? DEFAULT_ROBOTS;

  /** @param {Request} request @param {any} env @param {any} ctx @param {URL} url @param {string} requestId @param {import('./log.mjs').Logger} log */
  async function route(request, env, ctx, url, requestId, log) {
    const identity = workerIdentity(env);
    const host = classifyHost(url.hostname, identity);
    if (host === 'foreign') {
      log('warn', 'host_rejected', { requestId, host: url.hostname.slice(0, 253) });
      return problem(request, 421, 'Misdirected request', requestId);
    }
    if (!isSecureRequest(request, url)) {
      // A credential that crossed the wire in clear text can only be refused, never redirected.
      if (isAdminPath(url.pathname) || request.headers.has('authorization') || !READ_METHODS.has(request.method)) {
        return problem(request, 403, 'TLS required', requestId);
      }
      return redirect(url, identity.host);
    }
    if (host === 'alias') return redirect(url, identity.host);

    if (BUILT_IN.has(url.pathname)) {
      if (!READ_METHODS.has(request.method)) return problem(request, 405, 'Method not allowed', requestId, { allow: 'GET, HEAD' });
      if (url.pathname === '/version.json') return json({ app: identity.app, ...release });
      if (url.pathname === '/robots.txt') return text(robots);
      let healthy = true;
      if (health) {
        try { healthy = (await health(env)) !== false; } catch (error) {
          healthy = false;
          log('error', 'health_failed', { requestId, error });
        }
      }
      return json({ status: healthy ? 'ok' : 'degraded', app: identity.app, version: release.version }, healthy ? 200 : 503);
    }

    const admin = isAdminPath(url.pathname);
    if (admin) {
      const verdict = await opsAuthorization(request, env, url);
      if (verdict !== 'ok') {
        log('warn', 'admin_denied', { requestId, reason: verdict });
        if (verdict === 'unconfigured') return problem(request, 503, 'Operator access is not configured', requestId);
        if (verdict === 'insecure') return problem(request, 403, 'TLS required', requestId);
        return problem(request, 401, 'Operator authentication required', requestId,
          { 'www-authenticate': 'Basic realm="WizardGang Ops", charset="UTF-8"' });
      }
    }

    if (!appFetch) return notFound(request, requestId);
    const response = await appFetch(request, env, ctx, { app: identity.app, url, requestId, admin, log, release });
    if (response === null || response === undefined) return notFound(request, requestId);
    if (!(response instanceof Response)) throw new TypeError('app fetch must return a Response, null or undefined');
    return withSecurityHeaders(response);
  }

  return {
    async fetch(request, env, ctx) {
      const started = Date.now();
      const requestId = (request.headers.get('cf-ray') ?? crypto.randomUUID()).slice(0, 64);
      const log = createLogger(logName(env), logSink);
      let path = null;
      let status = 500;
      try {
        const url = new URL(request.url);
        path = url.pathname;
        const response = await route(request, env, ctx, url, requestId, log);
        status = response.status;
        return response;
      } catch (error) {
        log('error', 'unhandled', { requestId, error });
        return problem(request, 500, 'Internal error', requestId);
      } finally {
        log(status >= 500 ? 'error' : 'info', 'request', { requestId, method: request.method, path, status, ms: Date.now() - started });
      }
    },

    async scheduled(controller, env, ctx) {
      const started = Date.now();
      const log = createLogger(logName(env), logSink);
      const cron = controller?.cron ?? null;
      try {
        const { app } = workerIdentity(env);
        if (appScheduled) await appScheduled(controller, env, ctx, { app, log, release });
        log('info', 'scheduled', { cron, ms: Date.now() - started });
      } catch (error) {
        log('error', 'scheduled_failed', { cron, error, ms: Date.now() - started });
        // Mark the invocation failed without carrying the original error object out of the shell.
        throw new Error('scheduled handler failed');
      }
    },
  };
}
