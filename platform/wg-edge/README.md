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
| `WG_SESSION_KEY` | Secrets Store or secret | The root of every derived key (`deriveKey`). Also exposed through `sessionKey(env)`; the shell issues no sessions. |
| `GITHUB_APP_ID` | var | The numeric App ID of the `wg-github-app` credential. Only on Workers the registry lists as App consumers (the demo). |
| `GITHUB_APP_PRIVATE_KEY` | Worker secret | The App's RSA key as PKCS#8 PEM (`BEGIN PRIVATE KEY`). Never a var, and never in the Secrets Store. |
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

## Derived keys

`deriveKey(env, label)` returns 32 bytes of HKDF-SHA256 key material: the input key is `WG_SESSION_KEY` (UTF-8), the salt is `wizardgang wg-edge derived key v1` and the info is `wg-edge:<label>`. The same root and label always give the same bytes, and different labels give unrelated bytes. Import the bytes as an HMAC or AES key; never store or log them.

`DERIVED_KEYS` lists the labels and their consumer Workers, mirrored from the `derived` entries of baseline `config/secrets.json` and tied to them by a baseline test: `demo-session`, `identity-session` and `identity-audit`, all for `demo`. An undeclared label, a Worker that is not a consumer of the label, or a missing or empty `WG_SESSION_KEY` throws a `ConfigurationError` that carries no key material. Rotating `WG_SESSION_KEY` rotates every derived key at once, which signs out every session signed with one.

## GitHub App tokens

```js
const token = await githubAppToken(env, { installationId, permissions: { contents: 'read' } });
```

`githubAppToken` signs an RS256 app JWT with `GITHUB_APP_PRIVATE_KEY` through WebCrypto (`iat` 60 seconds back, `exp` 9 minutes ahead, `iss` the App ID). It exchanges the JWT at `POST /app/installations/<id>/access_tokens` for an installation token that holds exactly the requested permissions. At least one permission is required, each `read`, `write` or `admin`, and the response must grant every one. Tokens are cached in the isolate per App, installation and permission set until less than 5 minutes of their life remain, and concurrent callers share one exchange. A failed exchange is never cached.

The key must be PKCS#8. GitHub downloads App keys as PKCS#1 (`BEGIN RSA PRIVATE KEY`), which is refused with a message to convert it first. RSA keys under 2048 bits are refused. Line breaks or literal `\n` escapes are both accepted. A PKCS#8 RSA key (about 1.7 KB at 2048 bits, 3.3 KB at 4096) fits both a Secrets Store value (64 KiB) and a Worker secret (5 KB). It stays a Worker secret because the registry keeps the Secrets Store for shared `WG_` platform secrets and only the demo signs App tokens. `githubAppToken` reads either form, so a move would be a registry change only.

Every failure (a missing, malformed, PKCS#1 or short key, a malformed App ID, installation or permission set, an unreachable API, a refused exchange or an unexpected response) is a `GitHubAppError` with a fixed message and at most the HTTP status. No key, JWT, token or response body reaches an error, and so none reaches a log.

## Storage

Times are integer milliseconds since the epoch. Every D1 statement binds the Worker's own `WG_APP`, and every R2 key is prefixed `<app>/`. No helper takes an app argument.

- `records(env)`: `get`, `put` (upsert with `owner` and `ttlSeconds`), `delete` and `list` (by `owner`, ordered by id). Expired rows read as absent.
- `events(env)`: `append` (with `ttlSeconds`) and `list` (by `kind` and `since`).
- `sweepExpired(env)`: deletes this app's expired `records` and `events` rows. Call it from the scheduled handler.
- `bucket(env)`: `get`, `head`, `put`, `delete` and `list`, with keys relative to the prefix. Keys with empty, `.` or `..` segments, a leading `/`, backslashes or control characters are rejected. R2 object expiry is the bucket's lifecycle rules, not the sweeper.

Baseline is the only DDL owner for the shared database; consumers ship no DDL and no app-specific tables. The schema is [`platform/migrations/0001_universal.sql`](../migrations/0001_universal.sql): `records(app, collection, id, body, owner, created_at, updated_at, expires_at)` with primary key `(app, collection, id)`, and `events(app, kind, at, body, expires_at)`. Both are STRICT tables, so times must be integers. `body` is TEXT that must pass `json_valid`. The helpers' reads and deletes are all index searches: `records_owner`, `records_expiry`, `events_app_time` and `events_expiry`, plus the records primary key.
