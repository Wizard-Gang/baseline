# Implementation plan

## Open tasks

### BASE-036 — [FIX] Pass the account ID to every Worker at deploy time

- Dependency: None.
- Why: The demo's usage report needs `CLOUDFLARE_ACCOUNT_ID` at runtime. Its old `deploy.yml` passed it with `wrangler deploy --var`, but `deploy-worker.yml` does not, so since the demo moved to it (DEMO-459, v0.31.0) live `https://demo.wizardgang.ai/api/reporting/operations` reports Cloudflare analytics as not configured. The platform rule is that the account ID is never committed and deploys read `CLOUDFLARE_ACCOUNT_ID`, so the fix belongs in the deploy, not in a consumer's `wrangler.jsonc`.
- Scope:
  - `.github/workflows/deploy-worker.yml` passes `--var "CLOUDFLARE_ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID"` to `wrangler deploy`, from the `production` variable it already requires.
  - The `wrangler.jsonc` conformance check rejects a committed `vars.CLOUDFLARE_ACCOUNT_ID`, because the deploy supplies it.
  - `platform/deploy/README.md` documents that each deployed Worker receives the plain-text var `CLOUDFLARE_ACCOUNT_ID`.
  - Tests cover the deploy argument and the conformance rejection.
- Non-goals: No secret, token, permission, Worker name or provider change. No consumer change; each consumer picks this up when it next vendors `platform/` and pins `deploy-worker.yml`.
- Acceptance: A Worker deployed through `deploy-worker.yml` sees `env.CLOUDFLARE_ACCOUNT_ID`; a consumer `wrangler.jsonc` that commits it fails conformance. `npm run check` passes.
- Validation: Pinned `npm ci`, focused deploy-workflow and conformance tests, `npm run check`, `npm run audit:dependencies`, `git diff --check` and exact-head CI.
- Authorities: `.github/workflows/deploy-worker.yml`, `platform/conformance/`, `platform/deploy/README.md`, the demo's `src/lib/cloudflare-usage.ts` and its DEMO-482.

### BASE-037 — [FIX] End the demo deploy-token exception and let rotation find the account ID

- Dependency: BASE-036.
- Why: `config/secrets.json` maps the demo's `production` `CLOUDFLARE_API_TOKEN` to `wg-cloudflare-demo` because the demo deploy ran its own `demo-blob` D1 migrations. The exception's end condition has been met: the demo deploys through `deploy-worker.yml`, which runs no migrations, `git -C ~/Documents/GitHub/wizardgang-architecture-demo grep -n "d1 migrations apply" origin/main -- .github` prints nothing, and the `demo-blob` bucket and database are gone. Separately, on 2026-10-07 `rotate:cloudflare-token --apply` refused a valid rolled `wg-cloudflare-deploy` twice, because without `CLOUDFLARE_ACCOUNT_ID` in the shell it verifies the account-owned token at `/user/tokens/verify`.
- Scope:
  - Remove the `wg-cloudflare-demo` exception from `config/secrets.json`, so the demo's `production` `CLOUDFLARE_API_TOKEN` maps to `wg-cloudflare-deploy` and rotation writes all four targets.
  - When `CLOUDFLARE_ACCOUNT_ID` is unset, `rotate:cloudflare-token` reads it from the targets' `production` variable `CLOUDFLARE_ACCOUNT_ID` through `gh`, refuses if the targets disagree or none holds it, and then verifies at `/accounts/<id>/tokens/verify`.
  - `docs/SECRETS-RUNBOOK.md`, `docs/CLOUDFLARE-RUNBOOK.md` and `docs/OWNERSHIP.md` drop the exception, and give the owner's remaining step: roll `wg-cloudflare-deploy`, pipe it once through the rotation (4 targets), then delete `wg-cloudflare-demo` in the dashboard.
  - Tests cover the four-target mapping and the account ID lookup, including disagreement and absence.
- Non-goals: No provider change by an agent. The roll, the rotation run and the token deletion stay with the owner.
- Acceptance: `npm run rotate:cloudflare-token -- --credential wg-cloudflare-deploy` lists 4 targets, and `--apply` verifies an account-owned token with no `CLOUDFLARE_ACCOUNT_ID` in the shell. `npm run check` passes.
- Validation: Pinned `npm ci`, focused secret-registry, token-discovery, token-rotation and runbook tests, `npm run check`, `npm run audit:dependencies`, `git diff --check` and exact-head CI.
- Authorities: `config/secrets.json`, `scripts/rotate-cloudflare-token.mjs`, `scripts/cloudflare-token-targets.mjs`, `docs/SECRETS-RUNBOOK.md`, `docs/CLOUDFLARE-RUNBOOK.md`, `docs/OWNERSHIP.md`.
