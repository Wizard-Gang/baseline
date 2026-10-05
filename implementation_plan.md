# Implementation plan

## Open tasks

### BASE-034 — [FIX] Name the demo repository Wizard-Gang/wizardgang-architecture-demo

- Dependency: None. The demo's DEMO-457 updates its own committed identity in the same window.
- Why: On 2026-10-05 the owner transferred `wg-github-app` and then the demo repository from `SouthernGentlemen` to `Wizard-Gang`, and installed the App on the moved repository only (installation 168238365; App ID 5200141 unchanged). `SouthernGentlemen/wizardgang-architecture-demo` now redirects to `Wizard-Gang/wizardgang-architecture-demo`, but the Cloudflare desired state, the secret registry, the runbooks and the tests still name the old repository, so registry discovery and every runbook command address the demo through a redirect. The runbook also says the App belongs to `SouthernGentlemen` because a private App installs only on its owner's account; that is now `Wizard-Gang`.
- Scope:
  - `config/cloudflare.json` names the demo Worker's repository `Wizard-Gang/wizardgang-architecture-demo`.
  - `config/secrets.json` names the demo consumers `Wizard-Gang/wizardgang-architecture-demo:production` and `Wizard-Gang/wizardgang-architecture-demo:git-demo`, including the `wg-cloudflare-demo` exception consumer.
  - `docs/CLOUDFLARE-RUNBOOK.md` and `docs/SECRETS-RUNBOOK.md` address the demo as `Wizard-Gang/wizardgang-architecture-demo` in every command. The `wg-github-app` section says `Wizard-Gang` owns the App and creates it under the organization's GitHub Apps settings. The `wg-github-oauth` OAuth App stays under `SouthernGentlemen`, which still owns it.
  - The fake `gh` fixture and the secret-registry and secrets-runbook tests use the new repository.
- Non-goals: No provider change by an agent; the owner already moved the repository and the App. No change to Worker names, secret or variable names, `platform/`, the conformance desired state or any workflow.
- Acceptance: No tracked file outside the `wg-github-oauth` ownership line names `SouthernGentlemen/wizardgang-architecture-demo`; `npm run discover:cloudflare-token-targets` addresses `Wizard-Gang/wizardgang-architecture-demo` directly. `npm run check` passes.
- Validation: Pinned `npm ci`, focused secret-registry, token-discovery, token-rotation, Cloudflare-runbook and secrets-runbook tests, `npm run check`, `npm run audit:dependencies`, `git diff --check` and exact-head CI.
- Authorities: The owner's 2026-10-05 transfers (`gh api repos/Wizard-Gang/wizardgang-architecture-demo`, `gh api orgs/Wizard-Gang/installations`), `config/cloudflare.json`, `config/secrets.json`, `docs/CLOUDFLARE-RUNBOOK.md` and `docs/SECRETS-RUNBOOK.md`.
