# Implementation plan

## Open tasks

This queue normalizes every WizardGang secret. Baseline becomes the single registry of secret names, kinds and homes, and every repository and Worker follows it: the same name for the same purpose, the same shared credentials everywhere, and nothing outside the registry. No task here mints, sets, rotates or deletes a live secret, or changes Cloudflare, GitHub secrets or GitHub settings. The owner performs every provider change from the runbooks.

**Inventory, read 2026-10-04.** Names, locations and dates only, through `gh`, the Cloudflare API (GET only, audit token) and each repo's `origin/main`.

- Cloudflare account tokens: `wg-cloudflare-audit` (Mac keychain), `wg-cloudflare-deploy` (`production` environment `CLOUDFLARE_API_TOKEN` in WizardGang, SharkTank and Hexframe), `wg-cloudflare-demo` (the demo's `production` environment `CLOUDFLARE_API_TOKEN`, with D1 Edit for its own `demo-blob` migrations) and `wg-cloudflare-billing` (the demo Worker's `CLOUDFLARE_API_TOKEN`). Every personal-account token was revoked.
- The Secrets Store holds `WG_OPS_TOKEN` and `WG_SESSION_KEY`. Every config repository's `production` environment holds `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. SharkTank has the variable `PRODUCTION_DEPLOY_ENABLED`; baseline and YarReader hold nothing.
- The demo Worker holds 17 secrets, all read by its code. `GITHUB_REPORTING_WRITE_TOKEN` and `SAML_IDP_CERT` are declared but were never set. `DEMO_ADMIN_*` is live but not declared in `config/cloudflare.json`. The demo's GitHub Actions secret `GIT_DEMO_PR_TOKEN` is read only by `git-demo.yml`. SharkTank's `OPS_TOKEN` and `OPS_USERNAME` are removed by its ST-146.
- Dead on 2026-10-04: the demo's repository-level `CLOUDFLARE_API_TOKEN` (revoked) and `CLOUDFLARE_ACCOUNT_ID` (shadowed by its `production` environment), and archived FightLab's `production` `CLOUDFLARE_ACCOUNT_ID`. The owner deletes them directly.

**Owner decisions, 2026-10-04.**

- One GitHub App replaces `GITHUB_DEMO_TOKEN`, `GITHUB_READ_TOKEN`, `GITHUB_REPORTING_WRITE_TOKEN` and `GIT_DEMO_PR_TOKEN`.
- SAML stays supported. `SAML_IDP_CERT`, `SAML_IDP_ISSUER` and `SAML_SSO_URL` are public configuration, not secrets. Recommended default IdP: an enterprise application in the existing Microsoft Entra tenant.
- App keys are derived from `WG_SESSION_KEY` per purpose: `demo-session`, `identity-session` and `identity-audit` replace `DEMO_SESSION_SECRET`, `IDENTITY_SESSION_SECRET` and `IDENTITY_AUDIT_HMAC_SECRET`. The switch signs existing demo sessions out once.
- Every secret is the same across WizardGang. The demo's separate deploy token is a temporary exception: it ends when the demo stops running its own D1 migrations (its Phase 4 move to `records`/`events`), and then `wg-cloudflare-demo` is revoked.

**Naming rules for the registry.** `scripts/secret-registry.mjs` enforces them on `config/secrets.json` during `npm run check`.

1. A secret holds only secret material. Client IDs, tenant IDs, account IDs, issuers, URLs and public certificates are plain variables: `vars` in `wrangler.jsonc`, or GitHub environment variables.
2. Names are `<PROVIDER>_<PURPOSE>_<KIND>`, with KIND one of `TOKEN`, `CLIENT_SECRET`, `WEBHOOK_SECRET`, `PRIVATE_KEY` or `KEY`. A webhook secret's KIND names its purpose, so `GITHUB_WEBHOOK_SECRET` needs no PURPOSE. Shared platform secrets use the `WG_` prefix. `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` keep wrangler's names in GitHub.
3. One credential, one home, one name. A provider credential's console name is `wg-<provider>-<purpose>`, and it maps to exactly one secret name. A keychain item is named by its console credential.
4. GitHub Actions secrets live only in environments, never at repository level.
5. Every declared secret is set, and every set secret is declared.

**Target registry.** `config/secrets.json` records it, and `npm run check` enforces it.

- The registry is the target, not live state. `config/cloudflare.json` already gives the demo Worker the seven normalized secret names, so `npm run verify:cloudflare` reports the old names as drift until the demo's own normalization and Phase 4 land.
- `CLOUDFLARE_API_TOKEN` maps to `wg-cloudflare-deploy`. The registry's single exception maps the demo's `production` environment to `wg-cloudflare-demo` until the demo's Phase 4 D1 move, and then the exception is removed in the same change that revokes it.
- `CLOUDFLARE_ACCOUNT_ID` is registered as a `production` environment variable, and `deploy-worker.yml` reads only `vars.CLOUDFLARE_ACCOUNT_ID`. Live, every `production` environment still holds it as a secret. **The owner must set the variable in every `production` environment before the next deploy** (Cloudflare runbook R7). The owner deletes each secret only once that repository's own workflows stop reading `secrets.CLOUDFLARE_ACCOUNT_ID`; on 2026-10-04 the SharkTank, Hexframe and demo `deploy.yml` workflows still read it.
- `discover:cloudflare-token-targets` and `rotate:cloudflare-token` take their targets only from the registry. Rotation needs `--credential wg-cloudflare-deploy` or `--credential wg-cloudflare-demo` and writes only the environments mapped to that credential. Read-only discovery on 2026-10-04 reported nine drift items: the four `CLOUDFLARE_ACCOUNT_ID` secrets, the demo's missing `git-demo` environment, its repository-level `GIT_DEMO_PR_TOKEN` and its unregistered `production` variable `CLOUDFLARE_DO_NAMESPACE`, SharkTank's repository-level variable `PRODUCTION_DEPLOY_ENABLED`, and Hexframe's unregistered `production` variable `PRODUCTION_HOST`. Each one is resolved either by the owner from a runbook or by a baseline change that registers the name.
- `wg-edge` is vendored without `config/`, so it mirrors the registry names it needs. `DERIVED_KEYS` (`platform/wg-edge/keys.mjs`) equals the registry's `derived` entries with their consumers, and `GITHUB_APP` (`platform/wg-edge/github.mjs`) names `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `wg-github-app` and its consumer Workers. Baseline tests tie both to `config/secrets.json`, so a new derived label or App consumer changes the registry and the mirror in one change.
- `deriveKey(env, label)` is HKDF-SHA256 over `WG_SESSION_KEY` with salt `wizardgang wg-edge derived key v1` and info `wg-edge:<label>`. Derived keys are never minted, set or stored. Rotating `WG_SESSION_KEY` rotates every derived key at once and signs out every session signed with one.
- `githubAppToken` needs the App key as PKCS#8 (`BEGIN PRIVATE KEY`), RSA of at least 2048 bits. GitHub downloads PKCS#1 (`BEGIN RSA PRIVATE KEY`), which wg-edge refuses. A PKCS#8 RSA key is about 1.7 KB at 2048 bits, so it fits a Secrets Store value (65,536 bytes, Cloudflare docs read 2026-10-04) as well as a Worker secret (5 KB). It stays a Worker secret because the Secrets Store holds only shared `WG_` platform secrets and only the demo signs App tokens. wg-edge reads either form, so moving it would take only a registry change. Tokens are requested per call with explicit least-privilege permissions and cached per installation and permission set in the isolate.
- The conformance checker refuses every registry Worker secret as a `vars` entry on every Worker, not only on the secret's consumers.

**Per-repo work after this queue.** wg-edge now ships `deriveKey` and `githubAppToken`, so the demo can queue its own normalization task: renames, variables, `deriveKey` for `demo-session`, `identity-session` and `identity-audit`, `githubAppToken` in place of its three GitHub tokens, SAML configuration and the `git-demo` environment. It must vendor `platform/` from a merged baseline commit that includes both. The demo's `git-demo.yml` signs in GitHub Actions, not through wg-edge. SharkTank's ST-146 removes `OPS_*`. Each consumer's deploy must read `vars.CLOUDFLARE_ACCOUNT_ID`: through `deploy-worker.yml` at its Phase 4 migration, or by its own change if it deploys before then. SharkTank's `PRODUCTION_DEPLOY_ENABLED`, Hexframe's `PRODUCTION_HOST` and the demo's `CLOUDFLARE_DO_NAMESPACE` are either registered by a baseline change or deleted with their Phase 4 migrations. Beyond that, WizardGang and Hexframe need nothing outside their Phase 4 migrations.

### BASE-028 — [DOCS] Write the secrets runbook

- Dependency: none.
- Why: The owner mints, sets, rotates and revokes every registry credential, and each step needs a precondition, command, read-back and rollback.
- Scope: Add `docs/SECRETS-RUNBOOK.md`, linked from the README and the control map. Cover each registry credential:
  - the four Cloudflare tokens;
  - creating the GitHub App with minimum permissions. The App ID goes into the registered `GITHUB_APP_ID` variables. The installation ID is public configuration, not a secret, and the demo's own normalization decides where it lives. Its key must be converted from GitHub's PKCS#1 download to PKCS#8 (`openssl pkcs8 -topk8 -nocrypt`), and the converted key is set without echo: as the demo Worker secret `GITHUB_APP_PRIVATE_KEY` from stdin, and as the `git-demo` environment secret through `gh secret set --env`. The read-back compares the key's public SHA-256 fingerprint with the one GitHub shows and confirms the secret names exist. Rotation adds a second App key, sets it, verifies it and then deletes the old one in GitHub. The local PEM files are removed afterward;
  - the GitHub, Google and Microsoft OAuth clients, including the Entra secret's expiry;
  - the webhook secrets;
  - the SAML IdP configuration in Entra;
  - the `WG_SESSION_KEY`-derived keys. There is nothing to mint or set: `deriveKey` uses the HKDF parameters in the preamble. Rotating `WG_SESSION_KEY` rotates all of them and signs every session out. A new label means a registry change and a `DERIVED_KEYS` change together;
  - retiring each replaced secret, and revoking `wg-cloudflare-demo` when its exception ends.

  Fix the Cloudflare runbook: scope step 1.5's grep to the Worker source, and make every command self-contained, because each terminal run starts a fresh shell. Its step 3.6 and R7 already use the registry rotation syntax and the `CLOUDFLARE_ACCOUNT_ID` variable. Extend the documentation tests to check both runbooks against the registry.
- Non-goals: No provider change by an agent, and no token values or account ID.
- Acceptance: Every registry credential has a mint, set, read-back, rotate and revoke step. The documentation tests keep names, commands and links current against the registry and `package.json`.
- Validation: Pinned `npm ci`, focused tests, `npm run check`, `npm run audit:dependencies`, `check:patch`, `git diff --check` and exact-head CI.
- Authorities: The registry, the token scripts, `platform/wg-edge/` (`keys.mjs`, `github.mjs` and their README), `docs/CLOUDFLARE-RUNBOOK.md` and the 2026-10-04 inventory.
