# wg-edge

The shared Worker shell for the four `wizardgang.ai` Workers. It is dependency-free ESM with JSDoc types and a hand-written `index.d.ts`. Consumers vendor it from baseline; they never edit their copy.

```js
import { createEdge, records, sweepExpired } from './platform/wg-edge/index.mjs';

export default createEdge({
  release: { version: '1.4.0', commit: '<40-character commit>' },
  async fetch(request, env, ctx, edge) {
    if (edge.url.pathname === '/') return new Response('home');
    return null; // the shell answers an Accept-driven 404
  },
  async scheduled(controller, env, ctx, edge) {
    await sweepExpired(env);
  },
});
```

## Bindings

| Binding | Kind | Use |
| --- | --- | --- |
| `WG_APP` | var | The Worker label: `wizardgang`, `demo`, `sharktank` or `hexframe`. Anything else answers 500. |
| `WG_OPS_TOKEN` | Secrets Store or secret | The only operator credential. Unset or empty means every `/admin` request is denied. |
| `WG_SESSION_KEY` | Secrets Store or secret | Exposed to apps through `sessionKey(env)`; the shell issues no sessions. |
| `WG_DB` | D1 `wizardgang` | `records(env)`, `events(env)` and `sweepExpired(env)`. |
| `WG_R2` | R2 `wizardgang` | `bucket(env)`, under the `<app>/` prefix. |

## What every request gets

1. **Host guard.** Only the Worker's declared host is served (`WORKERS`, mirrored from `config/cloudflare.json`). A declared alias (`www.wizardgang.ai`) gets a 308 to the apex. Any other host gets 421.
2. **TLS.** Plain HTTP `GET`/`HEAD` gets a 308 to https. Plain HTTP writes, credentials and `/admin` requests get 403 and are never redirected.
3. **Built-ins.** `/version.json` (`app`, `version`, `commit`), `/health.json` (`ok`, or `degraded` with 503 when the optional `health(env)` returns false or throws) and `/robots.txt`.
4. **Operator gate.** `/admin` and `/admin/*`, also matched case-folded and percent-decoded. Admission needs TLS and either `Authorization: Bearer <WG_OPS_TOKEN>` or Basic `ops:<WG_OPS_TOKEN>`, compared in constant time over SHA-256 digests. An unset token gives 503 with no prompt; a wrong credential gives 401. The gate is lifted from SharkTank's `opsAuthorized` at `a031820`.
5. **Security headers.** HSTS, `nosniff`, `referrer-policy`, `x-frame-options: DENY` and `permissions-policy` are added to every response that lacks them. Shell responses also get `cache-control: no-store` and a `default-src 'none'` CSP. WebSocket upgrades pass through untouched.
6. **404s.** JSON unless the client's `Accept` lists `text/html`, then HTML.
7. **Error boundary.** A throw, or a non-`Response` result, becomes a 500 that carries only a fixed title and the request ID (`cf-ray` when present).
8. **Logs.** One JSON line per request: `ts`, `level`, `app`, `event`, `requestId`, `method`, `path`, `status` and `ms`. Query strings, headers and bodies are never logged, and errors are reduced to name and message.

The scheduled wrapper checks `WG_APP`, logs each run and rethrows a failure as a generic error.

## Storage

Times are integer milliseconds since the epoch. Every D1 statement binds the Worker's own `WG_APP`, and every R2 key is prefixed `<app>/`. No helper takes an app argument.

- `records(env)`: `get`, `put` (upsert with `owner` and `ttlSeconds`), `delete` and `list` (by `owner`, ordered by id). Expired rows read as absent.
- `events(env)`: `append` (with `ttlSeconds`) and `list` (by `kind` and `since`).
- `sweepExpired(env)`: deletes this app's expired `records` and `events` rows. Call it from the scheduled handler.
- `bucket(env)`: `get`, `head`, `put`, `delete` and `list`, with keys relative to the prefix. Keys with empty, `.` or `..` segments, a leading `/`, backslashes or control characters are rejected. R2 object expiry is the bucket's lifecycle rules, not the sweeper.

Baseline owns the shared schema; consumers ship no DDL. The helpers expect `records(app, collection, id, body, owner, created_at, updated_at, expires_at)` with primary key `(app, collection, id)`, and `events(app, kind, at, body, expires_at)`. `body` is JSON text.
