# Implementation plan

## Open tasks

### BASE-003 — [TEST] Prove controlled auto-merge lifecycle

- Dependency: BASE-002 has restored exact-head CI and live repository settings match the committed authority.
- Why: The baseline needs a provider-observed controlled PR proving that auto-merge waits for required checks and keeps one squash commit.
- Scope: Make a small contract or documentation improvement in one controlled commit, open its PR, enable per-PR auto-merge with the controlled squash subject and body while checks are pending, then verify the exact merged head, post-merge CI, branch cleanup, and live settings. Retire this task and leave the shared empty queue.
- Non-goals: Release tags, GitHub Releases, production deployment, application features, or bypassing required checks.
- Acceptance: GitHub merges the exact validated PR head only after all required current-with-main checks pass; one BASE-003 squash commit lands on main; post-merge CI succeeds; the branch is deleted; the settings verifier passes; the queue is empty.
- Validation: Pinned npm ci, focused settings cases, canonical check, separate dependency advisory audit, committed patch check, exact-head required CI, post-merge CI, history and provider readback.
- Authorities: AGENTS.md, docs/CHANGE-MANAGEMENT.md, docs/CONTROL-MAP.md, config/github-repository-settings.json, GitHub provider state.
