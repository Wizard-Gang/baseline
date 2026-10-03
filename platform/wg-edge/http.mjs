// Response building blocks shared by every Worker: one security header table, Accept-driven
// JSON or HTML bodies and the TLS check lifted from SharkTank `src/worker/index.ts` at a031820.

/** Applied to every response the shell answers or passes through, unless the app set its own value. */
export const SECURITY_HEADERS = Object.freeze({
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
});

// Shell-generated bodies load nothing, so they get the strictest policy.
const SHELL_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * Add the security headers an app response is missing. A WebSocket upgrade is returned untouched:
 * rebuilding it would drop the socket, and a 101 carries no document to protect.
 * @param {Response} response
 * @returns {Response}
 */
export function withSecurityHeaders(response) {
  if (response.status === 101 || /** @type {any} */ (response).webSocket) return response;
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!secured.headers.has(name)) secured.headers.set(name, value);
  }
  return secured;
}

/**
 * @param {number} status
 * @param {BodyInit | null} body
 * @param {Record<string, string>} headers
 */
function shellResponse(status, body, headers) {
  return new Response(body, {
    status,
    headers: { 'cache-control': 'no-store', 'content-security-policy': SHELL_CSP, ...SECURITY_HEADERS, ...headers },
  });
}

/**
 * @param {unknown} data
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 */
export function json(data, status = 200, headers = {}) {
  return shellResponse(status, JSON.stringify(data), { 'content-type': 'application/json; charset=utf-8', ...headers });
}

/**
 * @param {string} text
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 */
export function text(text, status = 200, headers = {}) {
  return shellResponse(status, text, { 'content-type': 'text/plain; charset=utf-8', ...headers });
}

/** @param {string} value */
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * A browser navigation asks for HTML; every other client (fetch, curl, monitors) gets JSON.
 * @param {Request} request
 */
export function wantsHtml(request) {
  const accept = (request.headers.get('accept') ?? '').toLowerCase();
  return /(^|,)\s*text\/html\s*(;|,|$)/.test(accept);
}

/**
 * One error shape for both forms. Only the status, a fixed title and the request ID ever leave the Worker.
 * @param {Request} request
 * @param {number} status
 * @param {string} title
 * @param {string} requestId
 * @param {Record<string, string>} [headers]
 */
export function problem(request, status, title, requestId, headers = {}) {
  if (!wantsHtml(request)) return json({ error: title, status, requestId }, status, headers);
  const safe = escapeHtml(title);
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${status} ${safe}</title></head>`
    + `<body><main><h1>${status} ${safe}</h1><p>Request ${escapeHtml(requestId)}</p></main></body></html>`;
  return shellResponse(status, body, { 'content-type': 'text/html; charset=utf-8', ...headers });
}

/**
 * @param {Request} request
 * @param {string} requestId
 */
export function notFound(request, requestId) {
  return problem(request, 404, 'Not found', requestId);
}

/**
 * TLS check. Behind Cloudflare the Worker URL is already https, but `cf-visitor` carries the
 * scheme the client actually used, so a plaintext client hop is still detectable.
 * @param {Request} request
 * @param {URL} url
 */
export function isSecureRequest(request, url) {
  const visitor = request.headers.get('cf-visitor');
  if (visitor) {
    try { return JSON.parse(visitor)?.scheme === 'https'; } catch { return false; }
  }
  const forwarded = (request.headers.get('x-forwarded-proto') ?? '').split(',')[0].trim().toLowerCase();
  if (forwarded) return forwarded === 'https';
  return url.protocol === 'https:';
}

/**
 * The 308 target on the canonical host, keeping path and query.
 * @param {URL} url
 * @param {string} host
 */
export function redirect(url, host) {
  return shellResponse(308, null, { location: `https://${host}${url.pathname}${url.search}` });
}
