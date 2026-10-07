# Implementation plan

## Open tasks

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
