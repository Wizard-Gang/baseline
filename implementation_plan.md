# Implementation plan

## Open tasks

### BASE-005 — [OPS] Cut and dispatch a verified reference release from accepted main

- Dependency: BASE-004 lands with the current queue and unchanged live main/tag protection.
- Why: The reference release should complete through chat-driven main delivery without a local tag push.
- Scope: After exact current-main CI succeeds, create or verify the annotated tag matching `package.json` and explicitly dispatch Release with its accepted commit. Preserve two-job archive reproduction, the SHA-256 manifest, attestation, retry-safe publication, and immutable Release checks. The existing `0.1.0` is the intended first release after this task merges and post-merge CI passes.
- Non-goals: Application code, hosted deployment, changed version, moved tags, or weaker provider protection.
- Acceptance: Exact tag and commit identity hold throughout dispatch and publication; a mismatched existing tag or Release fails closed; the first release's archive, manifest, attestation, and immutable GitHub Release verify.
- Validation: Focused workflow and release-contract tests, pinned npm ci, canonical check, advisory audit, committed patch check, exact-head required CI, post-merge CI, and provider release readback.
- Authorities: AGENTS.md, docs/CHANGE-MANAGEMENT.md, docs/RELEASE-MANAGEMENT.md, scripts/check-release.mjs, scripts/publish-release.mjs, config/github-repository-settings.json, and GitHub provider state.
