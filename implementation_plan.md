# Implementation plan

## Open tasks

### BASE-007 — [FIX] Repair release publication and publish a forward version

- Dependency: BASE-005 merged, main CI and Release Cutter passed, and the immutable `v0.1.0` tag was created at accepted main. Release run 36514488675 reproduced successfully but its publish job stopped before mutation because a shell `if` block omitted `fi`.
- Why: The reference release must complete through the chat-driven path, and the tagged workflow source at `v0.1.0` cannot be edited without moving its protected tag.
- Scope: Close the publish-job shell block, add a focused test that parses and syntax-checks literal Bash `run` blocks from release workflows, and advance `package.json` plus its lockfile to `0.1.1` so the repaired workflow can publish a forward release. Preserve the failed `v0.1.0` tag and its run evidence without fabricating a Release for it.
- Non-goals: Do not move or delete `v0.1.0`, bypass tag protection, weaken digest/attestation or immutable Release verification, or add application deployment.
- Acceptance: Focused tests fail on the missing `fi` fixture and pass with the repair; exact-head PR and postmerge CI pass; Release Cutter creates annotated `v0.1.1` at accepted main; both Release jobs pass; the archive, SHA-256 manifest, attestation and published immutable GitHub Release verify.
- Validation: Pinned npm ci, focused shell syntax and release-contract tests, canonical check, dependency audit, committed patch check, exact-head required CI, postmerge CI, and provider tag/Release/attestation readback.
- Authorities: AGENTS.md, docs/CHANGE-MANAGEMENT.md, docs/RELEASE-MANAGEMENT.md, `.github/workflows/release.yml`, `.github/workflows/release-cutter.yml`, scripts/check-release.mjs, scripts/publish-release.mjs, and GitHub run 36514488675.
