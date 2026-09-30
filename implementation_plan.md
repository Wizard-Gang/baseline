# Implementation plan

## Open tasks

### BASE-013 — [DOCS] Clarify connected GitHub delivery guidance

- Dependency: BASE-012 plan-only PR merged with successful post-merge CI; preserve its reserved task ID.
- Why: Align the shared agent contract with the wording accepted in wizardgang-architecture-demo as DEMO-390.
- Scope: Update `AGENTS.md` to distinguish ordinary connected GitHub PR delivery from settings administration and update its portfolio-contract hash in `scripts/check-portfolio-contract.mjs`.
- Non-goals: Do not change provider settings, required checks, release rules, versions, tags, Releases, or deployment behavior.
- Acceptance: The agent contract and hash match the accepted shared wording; one controlled PR retires BASE-013 after exact-head CI, squash merge, post-merge CI, and branch deletion.
- Validation: Pinned npm ci, canonical check, separate dependency audit, committed patch check, and GitHub exact-head and post-merge CI.
- Authorities: AGENTS.md, CONTRIBUTING.md, docs/CHANGE-MANAGEMENT.md, implementation_plan.md, scripts/check-portfolio-contract.mjs, and wizardgang-architecture-demo DEMO-390.
