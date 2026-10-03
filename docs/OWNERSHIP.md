# Ownership

The WizardGang repository owner is accountable for this contract and its GitHub settings. The change author owns the proposed patch and its evidence; the reviewer owns review of the exact head; the release operator owns tag and Release verification. A person may hold more than one role while the repository is small, but no role may claim a check that did not run. GitHub permissions and actual collaborators are verified live before an approval requirement is enabled. Ownership is assigned by provider permissions and this document; no unverified account or team is named as a code owner.

| Concern | Accountable role | Required evidence |
| --- | --- | --- |
| Governance and task order | Repository owner | Current plan, first task, accepted history |
| Controlled change | Change author | Branch, PR, one commit, complete record |
| Acceptance | Reviewer or repository owner | Exact-head checks, mergeability, policy readback |
| Provider settings and security | Repository owner | Committed policy, authorized apply, live readback |
| Shared edge code under `platform/` | Repository owner | `config/phase.json` platform grant, passing repository contract, no baseline deployment target |
| Shared database schema (all DDL for D1 `wizardgang`) | Repository owner | Baseline is the only DDL owner: contiguous, SHA-256 pinned `platform/migrations/NNNN_name.sql` files passing the migration contract; consumers ship no DDL or app-specific tables; the owner applies migrations from the runbook with live readback |
| Worker config conformance and vendoring pin | Repository owner | `platform/conformance/` and `platform/wrangler.template.jsonc` mirror `config/cloudflare.json` under test; consumers vendor `platform/` unedited with a `vendor.lock.json` printed by `npm run vendor:lock` from a merged commit |
| Reusable Worker deployment | Repository owner | `deploy-worker.yml` passing the deploy-workflow contract: `workflow_call` only, tag identity and conformance before the caller's `production` environment, provisioning off, 100% traffic and `/version.json` identity proven; consumers call it pinned to a merged commit, and baseline never calls it |
| Cloudflare desired state | Repository owner | `config/cloudflare.json` passing the closed validator; every provider change is owner-run with live readback through `npm run verify:cloudflare` |
| Release | Release operator | Annotated tag, reproduced artifact, immutable Release, digest and attestation verification |

Security reports go through [SECURITY.md](../SECURITY.md). High-risk changes require explicit rollback or forward-fix controls in the controlled record. Provider access failures block acceptance rather than silently delegating authority to a local assumption.
