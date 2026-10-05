# Implementation plan

## Open tasks

### BASE-030 — [FIX] Pass the caller's secrets to deploy-worker.yml and let the deploy token bind Secrets Store secrets

- Dependency: None.
- Why: WizardGang's first deploy through `deploy-worker.yml` (v1.3.0, run 37250078253, 2026-10-05) failed its credential guard. `vars.CLOUDFLARE_ACCOUNT_ID` arrived, but `secrets.CLOUDFLARE_API_TOKEN` was empty, although WizardGang's `production` environment holds it. A called workflow's `secrets` context holds only what the caller passes. Binding the caller's `production` environment inside the called job does not expose its secrets unless the caller passes `secrets: inherit` or maps them. Cloudflare also requires Account Secrets Store Edit on a token that deploys a `secrets_store_secrets` binding, and runbook step 3.6 minted `wg-cloudflare-deploy` without it. The owner added Secrets Store Edit to `wg-cloudflare-deploy` on 2026-10-05 and chose `secrets: inherit` over an explicit mapping.
- Scope:
  - The deploy-workflow contract requires a consumer to call `deploy-worker.yml` with `secrets: inherit`, from a repository in the `Wizard-Gang` organization only, because GitHub allows `inherit` only within one organization. `deploy-worker.yml` still declares no secrets and reads only `CLOUDFLARE_API_TOKEN` in the `deploy` job and only `vars.CLOUDFLARE_ACCOUNT_ID`. The `verify` job still reads no secret.
  - `scripts/deploy-workflow-contract.mjs` stops rejecting `secrets: inherit` in a consumer call. It keeps rejecting declared secrets and secret reads in `verify`. Its tests and `docs/CONTROL-MAP.md` follow.
  - `platform/deploy/README.md` documents the call shape with `secrets: inherit`, and why. Consumers re-vendor through `vendor:lock`.
  - Runbook step 3.6 and the `wg-cloudflare-deploy` entry in `docs/SECRETS-RUNBOOK.md` add Account Secrets Store Edit. Their documentation tests follow.
- Non-goals: No provider change by an agent. No new secret, registry entry or input. The demo, still under `SouthernGentlemen`, calls `deploy-worker.yml` only after its DEMO-457 move to `Wizard-Gang`.
- Acceptance: The contract accepts a `Wizard-Gang` consumer call with `secrets: inherit` and keeps rejecting secrets in `verify`, declared secrets and broader tokens. The vendored README and both runbooks describe the shipped behavior. `npm run check` passes.
- Validation: Pinned `npm ci`, focused deploy-workflow and runbook tests, `npm run check`, `npm run audit:dependencies`, `git diff --check` and exact-head CI.
- Authorities: Run 37250078253, `.github/workflows/deploy-worker.yml`, GitHub's reusable-workflow secrets rules, Cloudflare's Secrets Store access-control documentation, `docs/CLOUDFLARE-RUNBOOK.md` and `docs/SECRETS-RUNBOOK.md`.
