# Secrets runbook

The owner mints, sets, rotates and revokes every WizardGang credential from this runbook, on the Mac. No agent, workflow or `npm run check` runs these steps. [`config/secrets.json`](../config/secrets.json) is the registry: every secret, variable and derived key, its home and its consumers. It is the target, not live state. `npm run discover:cloudflare-token-targets` reads the GitHub side and `npm run verify:cloudflare` the Cloudflare side, names and dates only. This runbook names no token value, key material, App or installation ID, or account ID; resources and Cloudflare conventions are in [the Cloudflare runbook](CLOUDFLARE-RUNBOOK.md).

Each credential section lists six parts, in order. **Precondition** is a fresh read-only check. **Mint and set** creates the credential and writes it to every registry home. **Read-back** proves both. **Rotate** replaces it with no gap where the provider allows two at once. **Revoke** ends it and has its own read-back. **Rollback** says what can be undone. If a precondition does not hold, stop, change nothing, and fix this runbook through a controlled change.

## Commands

Every command is self-contained, because each terminal run starts a fresh shell; the rules of [the Cloudflare runbook](CLOUDFLARE-RUNBOOK.md#commands) apply, including its drift read. A value is never typed as an argument or echoed. It is generated with `openssl rand -hex 32` and piped, or copied from a console and piped with `pbpaste`, and the clipboard is cleared afterward with `pbcopy </dev/null`. A copy the owner keeps goes only into the password manager.

- The demo Worker is `wizardgang-architecture-demo` until the Cloudflare runbook's R3 renames it `demo`. Demo commands start with `W=wizardgang-architecture-demo`; after R3, run them with `W=demo`.
- **Name read** prints the demo Worker's secret names: `W=wizardgang-architecture-demo; npx --yes wrangler@4.147.0 secret list --name "$W" | jq -r '.[].name'`
- **GitHub read** prints every registry GitHub-environment secret and variable with its `updatedAt`, then the drift: `cd ~/Documents/GitHub/baseline && npm run discover:cloudflare-token-targets`
- A Worker variable (`vars` in the demo's `wrangler.jsonc`) is public configuration. The owner hands its value to the demo's own normalization change, which commits it in the demo repository and never in baseline. A Worker cannot hold a secret and a variable of the same name, so `MICROSOFT_TENANT_ID` is deleted as a secret (X1) in the same window as the deploy that adds it as a variable.

## Cloudflare tokens

All four are account-owned tokens under Manage Account → Account API Tokens, named by their console credential. **Roll** keeps a token's permissions and replaces its value at once, so the old value stops working immediately.

### wg-cloudflare-audit

- **Precondition:** `security find-generic-password -s wg-cloudflare-audit` reports no item (mint) or finds it (rotate, revoke).
- **Mint and set:** [Cloudflare runbook step 3.1](CLOUDFLARE-RUNBOOK.md#31-mint-the-read-only-audit-token-for-verifycloudflare): Read only on Workers Scripts, D1, Workers R2 Storage, Workers KV Storage and Secrets Store, stored at the hidden prompt of `security add-generic-password -a "$USER" -s wg-cloudflare-audit -w`.
- **Read-back:** The step 3.1 verify call prints `active`, and the drift read exits 0 or 1, never 2 or 3.
- **Rotate:** Roll it, then store the new value at the hidden prompt of `security add-generic-password -U -a "$USER" -s wg-cloudflare-audit -w` and repeat the read-back.
- **Revoke:** Delete it in the dashboard, then run `security delete-generic-password -s wg-cloudflare-audit`. The drift read then exits 2.
- **Rollback:** A rolled or deleted token cannot be restored; mint a new one by step 3.1.

### wg-cloudflare-deploy

- **Precondition:** The GitHub read lists `production` `CLOUDFLARE_API_TOKEN` with `wg-cloudflare-deploy` for WizardGang, SharkTank and Hexframe. No deploy is running: `for r in Wizard-Gang/WizardGang SouthernGentlemen/wizardgang-architecture-demo Wizard-Gang/SharkTank Wizard-Gang/Hexframe; do gh run list --repo "$r" --status in_progress; done` prints nothing.
- **Mint and set:** [Cloudflare runbook step 3.6](CLOUDFLARE-RUNBOOK.md#36-mint-the-scoped-deploy-token-and-set-it-in-every-production-environment): Workers Scripts Edit and Secrets Store Edit, plus Workers Routes Edit and Zone Read on `wizardgang.ai` only. Copy the value, then run `cd ~/Documents/GitHub/baseline && pbpaste | npm run rotate:cloudflare-token -- --credential wg-cloudflare-deploy --apply; pbcopy </dev/null`.
- **Read-back:** Rotation prints `Cloudflare reports the token as active.` and `Rotation of wg-cloudflare-deploy complete for all 3 target(s).`. The GitHub read shows the new `updatedAt` on those three lines only.
- **Rotate:** Roll it, then run the same pipe and read-back. The next deploy of each repository proves it.
- **Revoke:** Delete it in the dashboard only after a replacement is set, because every `deploy-worker.yml` deploy outside the demo uses it. The dashboard no longer lists it.
- **Rollback:** None for a rolled or deleted value; mint and set a new one. GitHub secrets are write-only.

### wg-cloudflare-demo

- **Precondition:** `config/secrets.json` holds the exception that maps the demo's `production` `CLOUDFLARE_API_TOKEN` to `wg-cloudflare-demo`, and the GitHub read shows that line. No demo deploy is running.
- **Mint and set:** Create it with Workers Scripts Edit and D1 Edit, plus Workers Routes Edit and Zone Read on `wizardgang.ai`; the D1 permission exists only for the demo's own `demo-blob` migrations. Copy the value, then run `cd ~/Documents/GitHub/baseline && pbpaste | npm run rotate:cloudflare-token -- --credential wg-cloudflare-demo --apply; pbcopy </dev/null`.
- **Read-back:** Rotation prints `Rotation of wg-cloudflare-demo complete for all 1 target(s).`, and the GitHub read shows the new `updatedAt` on the demo's line only.
- **Rotate:** Roll it, then run the same pipe and read-back.
- **Revoke:** When the exception ends: the demo's Phase 4 move to `records`/`events` is deployed, `git -C ~/Documents/GitHub/wizardgang-architecture-demo grep -n "d1 migrations apply" origin/main -- .github` prints nothing, and the baseline change that removes the exception is merged, so the GitHub read maps the demo's line to `wg-cloudflare-deploy`. Roll `wg-cloudflare-deploy` and pipe it through `rotate:cloudflare-token -- --credential wg-cloudflare-deploy --apply`, which now writes all 4 targets. Then delete `wg-cloudflare-demo` in the dashboard. The dashboard no longer lists it.
- **Rollback:** Until it is deleted, rotating it again restores the demo's line. After deletion, nothing; the demo deploys with `wg-cloudflare-deploy`.

### wg-cloudflare-billing

- **Precondition:** The name read shows whether `CLOUDFLARE_BILLING_TOKEN` is set. On 2026-10-04 this token is set under the demo's old name `CLOUDFLARE_API_TOKEN`, which X1 retires.
- **Mint and set:** Create it with Account Analytics Read and Billing Read only. Copy the value, or roll the existing token to get one, then run `W=wizardgang-architecture-demo; pbpaste | npx --yes wrangler@4.147.0 secret put CLOUDFLARE_BILLING_TOKEN --name "$W"; pbcopy </dev/null`. Until the demo's normalization deploys, put the same value under `CLOUDFLARE_API_TOKEN` too, because the running code still reads that name.
- **Read-back:** The name read lists `CLOUDFLARE_BILLING_TOKEN`. The demo operations report at `https://demo.wizardgang.ai/api/reporting/operations` shows Cloudflare usage as `available`. The drift read stops listing `Worker secret demo:CLOUDFLARE_BILLING_TOKEN` only after R3.
- **Rotate:** Roll it, then run the same put and read-back.
- **Revoke:** Delete it in the dashboard and run `W=wizardgang-architecture-demo; npx --yes wrangler@4.147.0 secret delete CLOUDFLARE_BILLING_TOKEN --name "$W"`. The report then shows Cloudflare usage as `unavailable`.
- **Rollback:** None for a rolled or deleted value; mint and put a new one.

## GitHub App

### wg-github-app

One private GitHub App replaces every GitHub personal token. A private App installs only on the account that owns it, so the owner of the demo repository, `SouthernGentlemen`, owns it. GitHub refuses Actions secret and variable names that start with `GITHUB_`, so the `git-demo` environment holds the key as `APP_PRIVATE_KEY` and the App ID as `APP_ID`, while the Worker holds `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_ID`.

- **Precondition:** The demo's own normalization task is queued. `gh api repos/SouthernGentlemen/wizardgang-architecture-demo/environments --jq '.environments[].name'` shows whether `git-demo` exists. Neither the name read lists `GITHUB_APP_PRIVATE_KEY` nor `gh secret list --repo SouthernGentlemen/wizardgang-architecture-demo --env git-demo` lists `APP_PRIVATE_KEY` (mint), or both do (rotate, revoke).
- **Mint and set:** Under Settings → Developer settings → GitHub Apps, create `wg-github-app`: homepage `https://demo.wizardgang.ai`, webhook inactive, installable only on this account. Repository permissions, the minimum the demo uses: Metadata Read; Contents Read and write (`git-demo.yml` pushes its branch and reads refs and `package.json`); Pull requests Read and write (opens, reads and merges the live-demo pull request); Actions Read and write (dispatches `git-demo.yml`, reads runs, jobs and artifacts); Issues Read and write (reporting writes issue state); Checks Read and Commit statuses Read (`gh pr checks`). No Administration, Secrets, Environments or Workflows permission and no account permission. Install it on the demo repository only. Create the `git-demo` environment before setting anything in it; GitHub answers HTTP 404 otherwise. The App ID (App settings, About) is public: copy it and set it with the third command below, and hand it to the demo's normalization for its `GITHUB_APP_ID` Worker variable. The installation ID (the number ending the installation's settings URL) is public configuration too, and that normalization decides where it lives. Generate a private key; GitHub downloads it as PKCS#1, which wg-edge refuses. Convert it to PKCS#8, then set it from stdin in both homes:

  ```sh
  umask 077; f="$(ls -t ~/Downloads/wg-github-app.*.private-key.pem | head -1)"; openssl pkcs8 -topk8 -nocrypt -in "$f" -out "$TMPDIR/wg-github-app.pkcs8.pem" && head -1 "$TMPDIR/wg-github-app.pkcs8.pem"
  W=wizardgang-architecture-demo; npx --yes wrangler@4.147.0 secret put GITHUB_APP_PRIVATE_KEY --name "$W" < "$TMPDIR/wg-github-app.pkcs8.pem"
  gh api -X PUT repos/SouthernGentlemen/wizardgang-architecture-demo/environments/git-demo --silent && pbpaste | gh variable set APP_ID --repo SouthernGentlemen/wizardgang-architecture-demo --env git-demo
  gh secret set APP_PRIVATE_KEY --repo SouthernGentlemen/wizardgang-architecture-demo --env git-demo < "$TMPDIR/wg-github-app.pkcs8.pem"
  ```

- **Read-back:** The first line printed is `-----BEGIN PRIVATE KEY-----`. The fingerprint below equals the `SHA256:` fingerprint GitHub shows beside the key under the App's Private keys. The name read lists `GITHUB_APP_PRIVATE_KEY`, and the GitHub read shows an `updatedAt` on the `git-demo` secret `APP_PRIVATE_KEY` and variable `APP_ID`. Then remove the local key files: `rm -f ~/Downloads/wg-github-app.*.private-key.pem "$TMPDIR/wg-github-app.pkcs8.pem"`.

  ```sh
  openssl rsa -in "$TMPDIR/wg-github-app.pkcs8.pem" -pubout -outform DER 2>/dev/null | openssl sha256 -binary | openssl base64
  ```

- **Rotate:** Generate a second private key in the App settings; GitHub keeps both valid. Run the conversion, both sets and the fingerprint read-back with the new download. Verify the demo: a `git-demo.yml` run passes, and the reporting pages read GitHub. Then delete the old key in the App settings, identified by its fingerprint, and remove the local key files.
- **Revoke:** Delete every private key in the App settings (or the App itself), then run `W=wizardgang-architecture-demo; npx --yes wrangler@4.147.0 secret delete GITHUB_APP_PRIVATE_KEY --name "$W"` and `gh secret delete APP_PRIVATE_KEY --repo SouthernGentlemen/wizardgang-architecture-demo --env git-demo`. Issued installation tokens expire within an hour. The App settings list no key, and the name read and the GitHub read show no App key.
- **Rollback:** Until the old key is deleted, it still signs; a failed rotation keeps it and generates another new key. A deleted key cannot be restored.

## OAuth clients

Each signs visitors in to the demo. Its client ID is a public Worker variable, and its client secret is the Worker secret. The callback is `https://demo.wizardgang.ai/auth/<provider>/callback` with provider `github`, `google` or `microsoft`.

### wg-github-oauth

- **Precondition:** The name read shows whether `GITHUB_OAUTH_CLIENT_SECRET` is set. Under Settings → Developer settings → OAuth Apps of `SouthernGentlemen`, `wg-github-oauth` exists with the callback `https://demo.wizardgang.ai/auth/github/callback`, or is created with it.
- **Mint and set:** Generate a new client secret, copy it, then run `W=wizardgang-architecture-demo; pbpaste | npx --yes wrangler@4.147.0 secret put GITHUB_OAUTH_CLIENT_SECRET --name "$W"; pbcopy </dev/null`. Hand the client ID to the demo's normalization as `GITHUB_OAUTH_CLIENT_ID`.
- **Read-back:** The name read lists it. After the normalized deploy, signing in at `https://demo.wizardgang.ai/auth/github` returns to the demo signed in.
- **Rotate:** An OAuth App holds two client secrets: generate the second, put it and verify sign-in, then delete the older secret in the console.
- **Revoke:** Delete its client secrets (or the OAuth App) in the console and run `W=wizardgang-architecture-demo; npx --yes wrangler@4.147.0 secret delete GITHUB_OAUTH_CLIENT_SECRET --name "$W"`. GitHub sign-in then fails closed.
- **Rollback:** Until the older secret is deleted, putting a still-listed secret again restores sign-in. A deleted secret cannot be restored.

### wg-google-oauth

- **Precondition:** The name read shows whether `GOOGLE_OAUTH_CLIENT_SECRET` is set. In the Google Cloud console under APIs & Services → Credentials, the web OAuth client `wg-google-oauth` exists with the redirect URI `https://demo.wizardgang.ai/auth/google/callback`, or is created with it.
- **Mint and set:** Add a client secret, copy it, then run `W=wizardgang-architecture-demo; pbpaste | npx --yes wrangler@4.147.0 secret put GOOGLE_OAUTH_CLIENT_SECRET --name "$W"; pbcopy </dev/null`. Hand the client ID to the demo's normalization as `GOOGLE_OAUTH_CLIENT_ID`.
- **Read-back:** The name read lists it. After the normalized deploy, signing in at `https://demo.wizardgang.ai/auth/google` returns to the demo signed in.
- **Rotate:** Add a second secret, put it and verify sign-in, then disable and delete the older one in the console.
- **Revoke:** Delete its secrets (or the client) and run `W=wizardgang-architecture-demo; npx --yes wrangler@4.147.0 secret delete GOOGLE_OAUTH_CLIENT_SECRET --name "$W"`. Google sign-in then fails closed.
- **Rollback:** A disabled secret can be enabled again until it is deleted. A deleted secret cannot be restored.

### wg-microsoft-oauth

- **Precondition:** The name read shows whether `MICROSOFT_OAUTH_CLIENT_SECRET` is set. In the Microsoft Entra admin center under App registrations, `wg-microsoft-oauth` exists with the web redirect URI `https://demo.wizardgang.ai/auth/microsoft/callback`, or is created with it. Its Certificates & secrets page shows each secret's expiry date.
- **Mint and set:** Add a client secret described `wg-microsoft-oauth` with a 180-day expiry (Entra allows at most 24 months). Copy its value, which Entra shows once, then run `W=wizardgang-architecture-demo; pbpaste | npx --yes wrangler@4.147.0 secret put MICROSOFT_OAUTH_CLIENT_SECRET --name "$W"; pbcopy </dev/null`. Record the expiry date in the password manager with a reminder 30 days before it. Hand the Application (client) ID and Directory (tenant) ID to the demo's normalization as `MICROSOFT_OAUTH_CLIENT_ID` and `MICROSOFT_TENANT_ID`.
- **Read-back:** The name read lists it, and Certificates & secrets lists the secret with its expiry. After the normalized deploy, signing in at `https://demo.wizardgang.ai/auth/microsoft` returns to the demo signed in.
- **Rotate:** Before the expiry date, add a new secret, put it and verify sign-in, then delete the older one. An expired secret stops Microsoft sign-in until this rotation runs.
- **Revoke:** Delete its secrets (or the registration) and run `W=wizardgang-architecture-demo; npx --yes wrangler@4.147.0 secret delete MICROSOFT_OAUTH_CLIENT_SECRET --name "$W"`. Microsoft sign-in then fails closed.
- **Rollback:** Until the older secret is deleted or expires, putting it again restores sign-in. A deleted secret cannot be restored.

## Webhook secrets

Neither has a console credential. The owner generates each value, and no copy is kept: rotation always makes a new one.

### GITHUB_WEBHOOK_SECRET

- **Precondition:** `gh api repos/SouthernGentlemen/wizardgang-architecture-demo/hooks --jq '.[].config.url'` shows whether the repository webhook to `https://demo.wizardgang.ai/webhooks/github` exists (none on 2026-10-04).
- **Mint and set:** Generate it into the clipboard and the Worker: `W=wizardgang-architecture-demo; v="$(openssl rand -hex 32)"; printf %s "$v" | pbcopy; printf %s "$v" | npx --yes wrangler@4.147.0 secret put GITHUB_WEBHOOK_SECRET --name "$W"; unset v`. In the demo repository's Settings → Webhooks, add the webhook: payload URL `https://demo.wizardgang.ai/webhooks/github`, content type `application/json`, the clipboard as its secret, SSL verification on, and the Releases event only. Then run `pbcopy </dev/null`.
- **Read-back:** The name read lists it. `gh api repos/SouthernGentlemen/wizardgang-architecture-demo/hooks --jq '.[] | select(.config.url == "https://demo.wizardgang.ai/webhooks/github") | .last_response.code'` is not 401; a 401 means the two copies differ.
- **Rotate:** Run the same generate-and-put, then change the webhook's secret to the clipboard right away and clear it. Redeliver any delivery that failed in between from the webhook's Recent Deliveries.
- **Revoke:** Delete the webhook, then run `W=wizardgang-architecture-demo; npx --yes wrangler@4.147.0 secret delete GITHUB_WEBHOOK_SECRET --name "$W"`. The endpoint then answers 503.
- **Rollback:** Once both copies agree again, redeliver the failed deliveries.

### DEMO_WEBHOOK_SECRET

- **Precondition:** The name read shows whether it is set. Nothing outside the demo holds it: the demo's webhook lab signs its own sample delivery and verifies it.
- **Mint and set:** `W=wizardgang-architecture-demo; openssl rand -hex 32 | npx --yes wrangler@4.147.0 secret put DEMO_WEBHOOK_SECRET --name "$W"`
- **Read-back:** The name read lists it, and after the normalized deploy the webhook lab verifies a sample delivery instead of answering `webhook_demo_not_configured`.
- **Rotate:** Run the same command and read-back.
- **Revoke:** `W=wizardgang-architecture-demo; npx --yes wrangler@4.147.0 secret delete DEMO_WEBHOOK_SECRET --name "$W"`. The lab then answers `webhook_demo_not_configured`.
- **Rollback:** Put a new value.

## SAML identity provider

### wg-saml-idp

The default IdP is an enterprise application in the existing Microsoft Entra tenant. It needs no secret: `SAML_IDP_CERT`, `SAML_IDP_ISSUER` and `SAML_SSO_URL` are public Worker variables that the demo's normalization commits.

- **Precondition:** `curl -fsS https://demo.wizardgang.ai/auth/saml/metadata` returns the demo's service-provider metadata, with its entity ID and the assertion consumer URL `https://demo.wizardgang.ai/auth/saml/acs`.
- **Mint and set:** In the Entra admin center, under Enterprise applications, create the non-gallery application `wg-saml-idp`. Under Single sign-on → SAML, set the Identifier to the metadata's entity ID and the Reply URL to the assertion consumer URL, and assign the users who may sign in. Download the Base64 signing certificate for `SAML_IDP_CERT`, and copy the Microsoft Entra Identifier for `SAML_IDP_ISSUER` and the Login URL for `SAML_SSO_URL`. Hand all three to the demo's normalization. Record the certificate's expiry in the password manager.
- **Read-back:** After the normalized deploy, `curl -sI https://demo.wizardgang.ai/auth/saml | grep -i '^location: https://login.microsoftonline.com/'` prints the redirect, a test sign-in returns to the demo signed in, and the Entra sign-in logs show it.
- **Rotate:** Before the certificate expires, add a new certificate under SAML Certificates, ship it as `SAML_IDP_CERT` in a demo change, then make it active and remove the old one.
- **Revoke:** Disable sign-in for `wg-saml-idp` (or delete it), and a demo change removes the three variables. SAML sign-in then fails closed.
- **Rollback:** Make the old certificate active again while it is listed, or enable the application again.

## Shared platform secrets

Both live only in the Secrets Store `default_secrets_store`, bound by every Worker that runs wg-edge. A Worker reads the current value at request time, so an update needs no deploy.

### WG_OPS_TOKEN

- **Precondition:** The drift read does not list `Secrets Store secret default_secrets_store:WG_OPS_TOKEN` under Missing (rotate, revoke), or does (mint).
- **Mint and set:** [Cloudflare runbook step 3.5](CLOUDFLARE-RUNBOOK.md#35-add-wg_ops_token-and-wg_session_key-to-the-secrets-store). The value goes into the password manager from the clipboard, and nowhere else.
- **Read-back:** `npx --yes wrangler@4.147.0 secrets-store secret list <store id> --remote` lists it. Once a Worker serves wg-edge, copy the token from the password manager and run `pbpaste | sed 's/^/Authorization: Bearer /' | curl -sS -o /dev/null -w '%{http_code}\n' -H @- https://hexframe.wizardgang.ai/admin; pbcopy </dev/null`: it prints neither 401 nor 503.
- **Rotate:** Generate the new value into the clipboard and the store, save it in the password manager, then clear the clipboard and repeat the read-back:

  ```sh
  A="$(npx --yes wrangler@4.147.0 whoami --json | jq -r '.accounts[0].id')"; get() { security find-generic-password -s wg-cloudflare-audit -w | sed 's/^/Authorization: Bearer /' | curl -fsS -H @- "https://api.cloudflare.com/client/v4/accounts/$A/secrets_store/stores$1"; }; S="$(get "" | jq -r '.result[] | select(.name == "default_secrets_store") | .id')"; I="$(get "/$S/secrets" | jq -r '.result[] | select(.name == "WG_OPS_TOKEN") | .id')"
  v="$(openssl rand -hex 32)"; printf %s "$v" | pbcopy; printf %s "$v" | npx --yes wrangler@4.147.0 secrets-store secret update "$S" --secret-id "$I" --remote; unset v
  ```

- **Revoke:** Rotate it to a value nobody keeps: the same block without `pbcopy`. Every `/admin` request is then refused. Deleting it from the store instead makes every gate answer 503.
- **Rollback:** The old value is in the password manager until it is replaced there; pipe it back with the same update.

### WG_SESSION_KEY and its derived keys

`deriveKey` turns `WG_SESSION_KEY` into the registry's derived keys `demo-session`, `identity-session` and `identity-audit`: HKDF-SHA256 over its UTF-8 bytes, salt `wizardgang wg-edge derived key v1`, info `wg-edge:<label>`, 32 bytes ([wg-edge](../platform/wg-edge/README.md#derived-keys)). There is nothing to mint, set or store for a derived key, and no copy of the root is kept.

- **Precondition:** As for `WG_OPS_TOKEN`, with `default_secrets_store:WG_SESSION_KEY`. Each derived label is a `derived` entry in `config/secrets.json` and in `DERIVED_KEYS` (`platform/wg-edge/keys.mjs`), which a baseline test keeps equal.
- **Mint and set:** [Cloudflare runbook step 3.5](CLOUDFLARE-RUNBOOK.md#35-add-wg_ops_token-and-wg_session_key-to-the-secrets-store). A new derived label is never minted: a baseline change adds it to the registry and `DERIVED_KEYS` together, and the consumer vendors that commit.
- **Read-back:** The store lists it. After the demo's normalization, a demo sign-in survives a reload, which proves `demo-session` and `identity-session` derive consistently.
- **Rotate:** Run the `WG_OPS_TOKEN` rotation block with `WG_SESSION_KEY` in the secret lookup and `openssl rand -hex 32 |` piped straight into the update, with no `pbcopy`. This rotates every derived key at once: every demo visitor and identity session is signed out, and audit HMACs made with the old `identity-audit` no longer verify.
- **Revoke:** Never without a replacement. Without the root, every `deriveKey` call fails closed with a `ConfigurationError`, so every session and audit feature of the demo stops.
- **Rollback:** None: the old root is not kept. Visitors sign in again.

## Retire the replaced secrets

| Old name and home | Replacement |
| --- | --- |
| Demo Worker `CLOUDFLARE_API_TOKEN` | `CLOUDFLARE_BILLING_TOKEN` (`wg-cloudflare-billing`) |
| Demo Worker `WEBHOOK_DEMO_SECRET` | `DEMO_WEBHOOK_SECRET` |
| Demo Worker `GITHUB_DEMO_TOKEN`, `GITHUB_READ_TOKEN`; repository `GIT_DEMO_PR_TOKEN` | Worker `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_ID`, `git-demo` `APP_PRIVATE_KEY` and `APP_ID` (`wg-github-app`) |
| Demo Worker `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` |
| Demo Worker `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` |
| Demo Worker `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID` | `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`, the variable `MICROSOFT_TENANT_ID` |
| Demo Worker `DEMO_SESSION_SECRET`, `IDENTITY_SESSION_SECRET`, `IDENTITY_AUDIT_HMAC_SECRET` | `demo-session`, `identity-session`, `identity-audit` |
| Demo Worker `DEMO_ADMIN_PASSWORD`, `DEMO_ADMIN_USER` | `WG_OPS_TOKEN` |

`GITHUB_REPORTING_WRITE_TOKEN` and the secret `SAML_IDP_CERT` were declared by the demo but never set, so nothing retires. Elsewhere: each `production` `CLOUDFLARE_ACCOUNT_ID` secret retires by Cloudflare runbook R7, SharkTank's `OPS_TOKEN` and `OPS_USERNAME` with its ST-146 and R3, and `wg-cloudflare-demo` by its own Revoke. Archived FightLab's `production` `CLOUDFLARE_ACCOUNT_ID` can be deleted only after the owner unarchives FightLab.

### X1 The `MICROSOFT_TENANT_ID` secret, immediately before the normalized deploy

- **Precondition:** The demo's normalization is merged, its deploy is about to run, and it commits `MICROSOFT_TENANT_ID` as a variable. The name read lists the secret `MICROSOFT_TENANT_ID`.
- **Command:** `W=wizardgang-architecture-demo; npx --yes wrangler@4.147.0 secret delete MICROSOFT_TENANT_ID --name "$W"`, then run the deploy at once. Microsoft sign-in is down in between.
- **Read-back:** The name read no longer lists it, the deploy passes, and Microsoft sign-in works.
- **Rollback:** If the deploy is abandoned, put the tenant ID back as the secret: copy it, then `W=wizardgang-architecture-demo; pbpaste | npx --yes wrangler@4.147.0 secret put MICROSOFT_TENANT_ID --name "$W"; pbcopy </dev/null`.

### X2 The old demo Worker secret names, after the normalized deploy

- **Precondition:** Every replacement's read-back passed. The Worker source of the latest successfully deployed demo commit reads none of the old names; this prints nothing:

  ```sh
  c="$(gh run list --repo SouthernGentlemen/wizardgang-architecture-demo --workflow deploy.yml --status success --limit 1 --json headSha --jq '.[0].headSha')"; git -C ~/Documents/GitHub/wizardgang-architecture-demo fetch -q origin && git -C ~/Documents/GitHub/wizardgang-architecture-demo grep -nwE "CLOUDFLARE_API_TOKEN|WEBHOOK_DEMO_SECRET|GITHUB_DEMO_TOKEN|GITHUB_READ_TOKEN|GITHUB_CLIENT_ID|GITHUB_CLIENT_SECRET|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|MICROSOFT_CLIENT_ID|MICROSOFT_CLIENT_SECRET|DEMO_SESSION_SECRET|IDENTITY_SESSION_SECRET|IDENTITY_AUDIT_HMAC_SECRET|DEMO_ADMIN_PASSWORD|DEMO_ADMIN_USER" "$c" -- src
  ```

- **Command:** `W=wizardgang-architecture-demo; for s in CLOUDFLARE_API_TOKEN WEBHOOK_DEMO_SECRET GITHUB_DEMO_TOKEN GITHUB_READ_TOKEN GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET MICROSOFT_CLIENT_ID MICROSOFT_CLIENT_SECRET DEMO_SESSION_SECRET IDENTITY_SESSION_SECRET IDENTITY_AUDIT_HMAC_SECRET DEMO_ADMIN_PASSWORD DEMO_ADMIN_USER; do npx --yes wrangler@4.147.0 secret delete "$s" --name "$W"; done`
- **Read-back:** The name read lists exactly the demo's seven registry secrets: `CLOUDFLARE_BILLING_TOKEN`, `DEMO_WEBHOOK_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, `GOOGLE_OAUTH_CLIENT_SECRET` and `MICROSOFT_OAUTH_CLIENT_SECRET`.
- **Rollback:** Redeploy the previous demo tag ([deploy rollback](CLOUDFLARE-RUNBOOK.md#deploy-rollback)) and put each old name it reads again, with the value of its replacement from a fresh rotation.

### X3 The demo's repository-level `GIT_DEMO_PR_TOKEN`

- **Precondition:** The GitHub read reports the repository-level secret `GIT_DEMO_PR_TOKEN`, and the `git-demo` secret and variable of `wg-github-app` are set. `git -C ~/Documents/GitHub/wizardgang-architecture-demo fetch -q origin && git -C ~/Documents/GitHub/wizardgang-architecture-demo grep -n "GIT_DEMO_PR_TOKEN" origin/main -- .github` prints nothing, and a `git-demo.yml` run has passed as the App.
- **Command:** `gh secret delete GIT_DEMO_PR_TOKEN --repo SouthernGentlemen/wizardgang-architecture-demo`
- **Read-back:** The GitHub read no longer reports it.
- **Rollback:** None is needed, because the registry allows no repository-level secret. A workflow that still needs a token is rolled back to its previous tag and signs as the App.

### X4 The personal access tokens behind the old GitHub names

- **Precondition:** X2 and X3 are done, so no home holds a personal token. On GitHub's Personal access tokens pages (fine-grained and classic), each token is identified by its name and last-used date. If one cannot be told apart from another token, stop.
- **Command:** Delete each of them there.
- **Read-back:** The pages no longer list them, and the demo's reporting and `git-demo.yml` still work through the App.
- **Rollback:** None for a deleted token; the App replaces it.

## Order and hand-off

These are the owner's recorded defaults as of 2026-10-04; changing one is a controlled change to this runbook.

- **The owner's order.** First, before the demo's normalization deploys: set `CLOUDFLARE_BILLING_TOKEN` (under both names), `wg-github-app` (with the `git-demo` environment), the three OAuth client secrets and both webhook secrets, and collect the public values for that change: the App and installation IDs, the OAuth client and tenant IDs and the SAML values. The `CLOUDFLARE_ACCOUNT_ID` variable is already set (Cloudflare runbook R7). Second, X1 runs immediately before that deploy. Third, after it, every read-back, then X2, X3, X4 and Cloudflare runbook R5. Last, at Phase 4: each R7 secret deletion as its repository stops reading it, R1 to R4, and the `wg-cloudflare-demo` Revoke at the demo's D1 move.
- **The demo's own normalization task.** The demo queues it in its own plan. It vendors `platform/` from a merged baseline commit that ships `deriveKey` and `githubAppToken`. It renames its Worker secrets to the seven registry names and commits the variables, uses `deriveKey` for `demo-session`, `identity-session` and `identity-audit` (signing demo sessions out once) and `githubAppToken` in place of its GitHub tokens, and drops `DEMO_ADMIN_*` for the `WG_OPS_TOKEN` gate. Its `git-demo.yml` signs as the App in GitHub Actions from the `git-demo` environment's `APP_ID` and `APP_PRIVATE_KEY`, not through wg-edge.
- **What stays drift until Phase 4.** `npm run verify:cloudflare` keeps reporting the old Worker names and their secrets, the `demo-blob`, `wizardgang-demo-assets` and `wizardgang-demo-r2` storage, and the declared Workers and their secrets as missing. The GitHub read keeps reporting the `CLOUDFLARE_ACCOUNT_ID` secrets of SharkTank, Hexframe and the demo until their own deploys stop reading them, and the unregistered `CLOUDFLARE_DO_NAMESPACE` (demo), `PRODUCTION_HOST` (Hexframe) and repository-level `PRODUCTION_DEPLOY_ENABLED` (SharkTank) until a baseline change registers each or its Phase 4 migration deletes it. The demo's `git-demo` environment and `GIT_DEMO_PR_TOKEN` stay drift until the App steps and X3 run.
