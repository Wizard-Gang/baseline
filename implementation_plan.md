# Implementation plan

## Open tasks

### BASE-011 — [OPS] Govern immutable Releases and publish a forward version

- Dependency: BASE-009 merged and `v0.1.2` reproduced, attested, and published, but its final guard found `immutable: false`. Repository immutable Releases are now enabled and read back as `enabled: true`; GitHub applies this setting only to future publications.
- Why: The committed settings authority did not include GitHub's immutable Releases setting, so provider drift escaped the prepublication controls. The already published `v0.1.2` Release cannot become immutable retroactively.
- Scope: Add immutable Releases to the committed provider settings authority, read-only comparison and bounded settings application, with focused regression tests and release-management documentation. Advance package and lockfile version to `0.1.3` for a fresh, protected reference Release.
- Non-goals: Do not delete, unpublish, or edit the earlier Releases; move or delete `v0.1.0`, `v0.1.1`, or `v0.1.2` tags; weaken provenance, digest, release attestation, or main protection; or add an application deployment.
- Acceptance: Settings verification fails when immutable Releases are disabled and passes against the live enabled setting; bounded application preserves it. Exact-head PR and postmerge CI pass; Release Cutter creates annotated `v0.1.3` at accepted main; Release verifies matching assets, build provenance, Release attestations and `immutable: true`.
- Validation: Pinned npm ci, focused provider settings and release tests, canonical check, dependency audit, committed patch check, live settings readback, exact-head required CI, postmerge CI, and provider tag, Release, asset and attestation readback.
- Authorities: AGENTS.md, docs/CHANGE-MANAGEMENT.md, docs/RELEASE-MANAGEMENT.md, config/github-repository-settings.json, scripts/github-repository-settings.mjs, scripts/apply-github-repository-settings.mjs, GitHub immutable Releases API, and Release run 36632302349.
