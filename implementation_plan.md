# Implementation plan

## Open tasks

### BASE-039 — [BUILD] Deploy on the caller's reproduction proof and export one verified result

- Dependency: None.
- Why: Every caller already reproduces its tag with `npm ci` and `npm run check` before it calls `deploy-worker.yml`, and the `verify` job then runs the same full acceptance suite again with no credentials in reach. The demo's v0.31.0 never deployed because of that second run (DEMO-480). The workflow also ends without a result a caller can record, so the demo keeps a hand-written deployment ledger. The demo's DEMO-505 needs this contract upstream before DEMO-506 can record deployments automatically.
- Scope:
  - A read-only Actions evidence adapter in `platform/deploy/` reads the current run, its attempt's jobs and the tag's Release through the run's own `github.token`, with bounded requests and timeouts. Pure predicates accept only:
    - a run in the caller's own repository (not a fork) at the expected commit, on the tag or `main`, by `push` or `workflow_dispatch`, in the current attempt;
    - a run that references exactly one `Wizard-Gang/baseline/.github/workflows/deploy-worker.yml` commit, which must equal the vendored `platform/vendor.lock.json` commit;
    - a caller workflow, read at the expected commit, in which the job that calls `deploy-worker.yml` needs exactly one job that sets up `.node-version` and runs `npm ci` and `npm run check`, with no `continue-on-error` and no other checkout ref;
    - that job completed successfully in this attempt at the expected commit;
    - a published, non-draft Release for the tag.
  - Missing, unreadable or mismatched evidence fails. There is no fallback to a local full check.
  - The `verify` job keeps the annotated tag, `package.json` version, expected commit on `main`, pin and Wrangler conformance checks. It drops `npm ci` and `npm run check`. Only that job gains `actions: read`.
  - The `deploy` job keeps the production-bound `npm ci` and build with `WG_VERSION`/`WG_COMMIT`. It also keeps the protected `production` environment, per-Worker serialization without cancellation, provisioning off, and the bounded check that the Wrangler Version ID serves 100% of traffic.
  - The bounded `/version.json` poll reports a Cloudflare challenge apart from a timeout and never redeploys.
  - New one-shot checks run after convergence:
    - `/health.json` returns `ok` with the label and version;
    - the root page, after at most three same-origin redirects, is HTML, and each same-origin script and stylesheet it names (at most 20) loads with a matching type.
  - After all observations pass, the verifier emits one compact, whitelisted result: schema, worker, host, repository, run ID and attempt, tag, full commit, observed time, Worker version ID, traffic percentage and check outcomes. It refuses any other field or value shape. The result is exported as the reusable-workflow output `result`.
  - The contract, tests, deploy README, release-management, ownership, control-map and runbook text change to match. Contract fixtures that require `npm run check` inside `verify` are deleted.
- Non-goals:
  - No attestation service, new secret, credential, environment, approval or provisioning.
  - No self-declared proof input and no second production browser suite.
  - No deploy only to wait for propagation, and no consumer change. Each consumer adopts this when it next vendors `platform/` and pins the workflow; its caller job must then grant `actions: read`.
- Acceptance:
  - A caller run whose named reproduction job passed at the tag commit deploys without running `npm run check` again, and returns `result`.
  - A wrong repository, run, attempt, commit or deploy-worker commit fails before production can be reached. So do a failed, absent or ambiguous reproduction job, an unpublished Release and unreadable evidence.
  - A traffic, version, challenge, health or asset failure fails the deploy with no result.
  - `npm run check` passes.
- Validation: Pinned `npm ci`, focused deploy-evidence, deploy-verify and deploy-workflow-contract tests covering each failure above and the result redaction, `npm run check`, `npm run audit:dependencies`, `check:patch`, `git diff --check` and exact-head CI.
- Authorities: `.github/workflows/deploy-worker.yml`, `platform/deploy/`, `scripts/deploy-workflow-contract.mjs`, `docs/RELEASE-MANAGEMENT.md`, `docs/CLOUDFLARE-RUNBOOK.md`, `config/secrets.json`, and the demo's DEMO-505 in `implementation_plan.md`.
