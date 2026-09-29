# Implementation plan

## Open tasks

### BASE-009 — [FIX] Repair draft lookup and publish a forward reference release

- Dependency: BASE-007 merged with successful main CI, Release Cutter created annotated `v0.1.1`, and Release run 36515495727 attested its archive but failed after creating draft 398791176 because release-by-tag REST lookup returned 404 for that draft.
- Why: The reference release must finish through the chat-driven path. The immutable `v0.1.1` tag runs the old publisher, so the correction needs a fresh version.
- Scope: Resolve existing draft or published Releases by ID before deciding whether to create or resume publication; cover draft lookup and retry behavior with focused tests; advance package and lockfile version to `0.1.2` for the corrected publisher to run on GitHub's Linux runner.
- Non-goals: Do not move, delete, or overwrite `v0.1.0` or `v0.1.1`; weaken annotated tag, digest, provenance, or immutable Release checks; or add application deployment.
- Acceptance: Exact-head PR and postmerge CI pass; Release Cutter creates annotated `v0.1.2` at accepted main; Release reproduces and attests the archive, publishes both digest-matched assets, and verifies an immutable GitHub Release. Preserve earlier failed tags and the `v0.1.1` draft as historical evidence.
- Validation: Pinned npm ci, focused publisher tests, canonical check, dependency audit, committed patch check, exact-head required CI, postmerge CI, and provider tag, Release, asset and attestation readback.
- Authorities: AGENTS.md, docs/CHANGE-MANAGEMENT.md, docs/RELEASE-MANAGEMENT.md, `.github/workflows/release.yml`, `.github/workflows/release-cutter.yml`, scripts/release-contract.mjs, scripts/publish-release.mjs, and GitHub run 36515495727.
