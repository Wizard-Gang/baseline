# Implementation plan

## Open tasks

### BASE-032 — [FIX] Name the git-demo App secret and variable APP_PRIVATE_KEY and APP_ID

- Dependency: None.
- Why: GitHub Actions refuses any secret or variable name that starts with `GITHUB_`. On 2026-10-05 the owner followed the `wg-github-app` runbook step: `gh secret set GITHUB_APP_PRIVATE_KEY --env git-demo` failed with HTTP 422 "Secret names must not start with GITHUB_", and `gh variable set GITHUB_APP_ID --env git-demo` failed the same way. The registry declares both names in the demo's `git-demo` environment, so it requires names GitHub cannot store, and the registry validator demands the `GITHUB_` prefix for every `github` provider name. The owner chose `APP_PRIVATE_KEY` and `APP_ID` and set them in `git-demo`; the Worker keeps `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_ID`, which Cloudflare accepts. The runbook also sets the `git-demo` variable before it creates the environment, which fails with HTTP 404.
- Scope:
  - `config/secrets.json` renames the two `github-environment` entries for `SouthernGentlemen/wizardgang-architecture-demo:git-demo` to `APP_PRIVATE_KEY` (secret, `wg-github-app`) and `APP_ID` (variable). The Worker entries are unchanged.
  - `scripts/secret-registry.mjs` refuses any `github-environment` name that starts with `GITHUB_`, because GitHub reserves the prefix. A `github` provider name in a GitHub environment drops the prefix and keeps `<PURPOSE>_<KIND>`; it is the Worker name without `GITHUB_`, so one console credential may map to both forms of one name and to no other name. Its tests and `docs/CONTROL-MAP.md` follow.
  - The token-target discovery and rotation tests and their fake `gh` fixture use the new names.
  - The `wg-github-app` section of `docs/SECRETS-RUNBOOK.md` creates the `git-demo` environment before it sets anything in it, sets `APP_PRIVATE_KEY` and `APP_ID` there, and says why the names differ from the Worker's. The migration rows and the demo normalization text follow, and the runbook test follows.
- Non-goals: No provider change by an agent; the owner already set the new names. No change to `platform/wg-edge`, the Worker names, the conformance desired state or any workflow.
- Acceptance: The registry and the runbook name only names GitHub can store; the validator rejects a `GITHUB_` name in a GitHub environment; `npm run discover:cloudflare-token-targets` would compare `APP_PRIVATE_KEY` and `APP_ID` in `git-demo`. `npm run check` passes.
- Validation: Pinned `npm ci`, focused secret-registry, token-discovery, token-rotation and secrets-runbook tests, `npm run check`, `npm run audit:dependencies`, `git diff --check` and exact-head CI.
- Authorities: GitHub's Actions naming rules for secrets and variables, the owner's 2026-10-05 HTTP 422 read-backs, `config/secrets.json`, `scripts/secret-registry.mjs` and `docs/SECRETS-RUNBOOK.md`.
