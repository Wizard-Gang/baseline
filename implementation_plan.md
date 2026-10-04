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

**Naming rules for the registry.**

1. A secret holds only secret material. Client IDs, tenant IDs, account IDs, issuers, URLs and public certificates are plain variables: `vars` in `wrangler.jsonc`, or GitHub environment variables.
2. Names are `<PROVIDER>_<PURPOSE>_<KIND>`, with KIND one of `TOKEN`, `CLIENT_SECRET`, `WEBHOOK_SECRET`, `PRIVATE_KEY` or `KEY`. Shared platform secrets use the `WG_` prefix. `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` keep wrangler's names in GitHub.
3. One credential, one home, one name. A provider credential's console name is `wg-<provider>-<purpose>`, and it maps to exactly one secret name.
4. GitHub Actions secrets live only in environments, never at repository level.
5. Every declared secret is set, and every set secret is declared.

**Target registry.**

- GitHub `production` environment of every config repository: secret `CLOUDFLARE_API_TOKEN` (`wg-cloudflare-deploy`, or `wg-cloudflare-demo` for the demo until its exception ends) and variable `CLOUDFLARE_ACCOUNT_ID`.
- Secrets Store, bound by any Worker that needs them: `WG_OPS_TOKEN` and `WG_SESSION_KEY`, plus derived keys by label.
- Demo Worker secrets: `CLOUDFLARE_BILLING_TOKEN` (`wg-cloudflare-billing`), `GITHUB_APP_PRIVATE_KEY` (`wg-github-app`), `GITHUB_OAUTH_CLIENT_SECRET` (`wg-github-oauth`), `GOOGLE_OAUTH_CLIENT_SECRET` (`wg-google-oauth`), `MICROSOFT_OAUTH_CLIENT_SECRET` (`wg-microsoft-oauth`), `GITHUB_WEBHOOK_SECRET` and `DEMO_WEBHOOK_SECRET`.
- Demo Worker variables: `GITHUB_APP_ID`, `GITHUB_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_TENANT_ID`, `SAML_IDP_CERT`, `SAML_IDP_ISSUER` and `SAML_SSO_URL`.
- The demo's `git-demo` environment: `GITHUB_APP_PRIVATE_KEY` and variable `GITHUB_APP_ID`.
- Mac keychain: `wg-cloudflare-audit`.

**Per-repo work after this queue.** The demo queues its own normalization task (renames, variables, derived keys, GitHub App, SAML configuration) after BASE-027 merges. SharkTank's ST-146 removes `OPS_*`. WizardGang and Hexframe need nothing beyond their Phase 4 migrations.

### BASE-025 — [SEC] Add the WizardGang secret registry

- Dependency: none.
- Why: Secret names, kinds and homes are scattered across repositories and consoles, and one name currently holds three different credentials.
- Scope: Add `config/secrets.json` and a closed validator run by `npm run check`. Each entry records the name, kind (`secret`, `variable` or `derived`), home (Worker, Secrets Store, GitHub environment or keychain), consumers, provider, console credential name and purpose. The validator enforces the naming rules. It requires every Worker's `secrets` in `config/cloudflare.json` to equal the registry's Worker secrets for that Worker, and the Secrets Store list to equal the registry's. Record the target registry above, including the demo's deploy-token exception and its end condition. Update the demo's `secrets` list in `config/cloudflare.json` to the normalized names.
- Non-goals: No live secret change and no consumer change.
- Acceptance: The registry holds every target entry. The validator rejects an unknown key, a misnamed secret, a public value stored as a secret, a duplicate home, a repository-level GitHub secret and a mismatch with `config/cloudflare.json`.
- Validation: Pinned `npm ci`, focused registry tests, `npm run check`, `npm run audit:dependencies`, `git diff --check` and exact-head CI.
- Authorities: This plan's preamble, `config/cloudflare.json` and the 2026-10-04 inventory.

### BASE-026 — [SEC] Drive discovery and rotation from the registry

- Dependency: BASE-025 merged.
- Why: The rotation tool writes one token to every production environment, which overwrites the demo's own deploy token, and discovery checks only `CLOUDFLARE_API_TOKEN`.
- Scope: `discover:cloudflare-token-targets` and `rotate:cloudflare-token` read their targets from the registry. Rotation takes the console credential name (`--credential wg-cloudflare-deploy`) and writes only the environments mapped to it. Discovery reports every registry GitHub secret and variable in the config repositories, and any secret or variable outside the registry (repository level, another environment or an unknown name) as drift. `deploy-worker.yml` reads `CLOUDFLARE_ACCOUNT_ID` as an environment variable instead of a secret, and its contract follows.
- Non-goals: No rotation run and no secret or variable change.
- Acceptance: Stub-`gh` tests prove that rotation with each credential touches only its mapped targets, that the demo's token survives a `wg-cloudflare-deploy` rotation, and that discovery flags unregistered and repository-level entries. The deploy-workflow contract requires `vars.CLOUDFLARE_ACCOUNT_ID`.
- Validation: As for BASE-025.
- Authorities: The registry, the existing token scripts and `deploy-worker.yml`.

### BASE-027 — [FEAT] Add key derivation and GitHub App tokens to wg-edge

- Dependency: BASE-025 merged.
- Why: Every Worker should derive its app keys from `WG_SESSION_KEY` and reach GitHub through the one App, rather than each holding its own keys and personal tokens.
- Scope: `deriveKey(env, label)` derives HKDF-SHA256 key material from `WG_SESSION_KEY` for a label declared in the registry. `githubAppToken(env, { installationId, permissions })` signs an RS256 app JWT from `GITHUB_APP_ID` and a PKCS#8 `GITHUB_APP_PRIVATE_KEY`, exchanges it for an installation token and caches the token until shortly before it expires. Check that the private key fits a Secrets Store value; if it does not, it stays a Worker secret. Update `index.d.ts`, the README and the conformance allowlist for the new bindings.
- Non-goals: No consumer change and no App creation.
- Acceptance: Tests prove that derivation is deterministic per label and separate across labels, that unknown labels fail closed, and that the JWT claims and signature verify. They also prove that the token exchange is cached and refreshed, and that a missing or malformed key fails closed without leaking it.
- Validation: As for BASE-025.
- Authorities: The registry and `platform/wg-edge/`.

### BASE-028 — [DOCS] Write the secrets runbook

- Dependency: BASE-025, BASE-026 and BASE-027 merged.
- Why: The owner mints, sets, rotates and revokes every registry credential, and each step needs a precondition, command, read-back and rollback.
- Scope: Add `docs/SECRETS-RUNBOOK.md`, linked from the README and the control map. Cover each registry credential:
  - the four Cloudflare tokens;
  - creating the GitHub App with minimum permissions, converting its key to PKCS#8 and setting it;
  - the GitHub, Google and Microsoft OAuth clients, including the Entra secret's expiry;
  - the webhook secrets;
  - the SAML IdP configuration in Entra;
  - generating `WG_SESSION_KEY`-derived keys;
  - retiring each replaced secret, and revoking `wg-cloudflare-demo` when its exception ends.

  Fix the Cloudflare runbook: scope step 1.5's grep to the Worker source, and make every command self-contained, because each terminal run starts a fresh shell. Extend the documentation tests to check both runbooks against the registry.
- Non-goals: No provider change by an agent, and no token values or account ID.
- Acceptance: Every registry credential has a mint, set, read-back, rotate and revoke step. The documentation tests keep names, commands and links current against the registry and `package.json`.
- Validation: As for BASE-025.
- Authorities: The registry, the token scripts, `docs/CLOUDFLARE-RUNBOOK.md` and the 2026-10-04 inventory.
