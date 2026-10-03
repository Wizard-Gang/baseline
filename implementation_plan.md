# Implementation plan

## Open tasks

This queue builds the platform half of the Cloudflare consolidation for the four `wizardgang.ai` hosts: `wizardgang.ai`, `demo.`, `sharktank.` and `hexframe.`. Baseline becomes the single authority for the shared edge shell, the shared database schema, the desired Cloudflare state, Worker config conformance, deployment and Cloudflare token handling. No task here deploys a Worker or mutates Cloudflare, GitHub secrets or GitHub settings. The owner runs every provider mutation from the BASE-023 runbook.

**Phases.** Phase 1 deletes orphans; the owner does this from the runbook. Phase 2 is this queue. Phase 3 provisions the shared resources; the owner does this from the runbook after BASE-023. Phase 4 is the per-repo migrations, which each consuming repo queues in its own plan.

**Live state, read 2026-10-03.** This was read through the Cloudflare API (GET only), `gh` and each repo's `origin/main`. It matches the 2026-10-02 audit except where noted.

- Workers and their custom domains:
  - `wizardgang-portfolio` → `wizardgang.ai`
  - `wizardgang-architecture-demo` → `demo.`
  - `wizardgangprod` → `sharktank.`
  - `hexframe` → `hexframe.`
- `wizardgang-portfolio-staging` has no custom domain. It is the only Worker with workers.dev enabled. No Worker has preview URLs. The `www` → apex 308 is an unmanaged zone rule.
- Compatibility dates range from 2026-06-28 to 2026-08-31. Only `hexframe` has observability enabled. Crons: the demo runs `*/5 * * * *`; `wizardgangprod` runs `17 3 * * *`.
- Storage:
  - D1: `demo-blob` (8.7 MB) and an empty orphan, `wizardgang-demo-data`.
  - R2: `wizardgang-demo-assets` (SharkTank backups), `wizardgang-demo-r2` (demo) and an empty orphan, `wizardgang-demo-r2-preview`.
  - KV: two orphans from the August platform, `wg-gateway-status-dev` and `-prod`.
  - Durable Objects: `wizardgangprod` has `Room` and `Lobby`; the demo has `DemoCoordinator`.
  - Secrets Store: `default_secrets_store` exists with zero secrets.
- Worker secrets: Hexframe still holds dead `ADMIN_*` secrets. `wizardgangprod` has `OPS_TOKEN` and `OPS_USERNAME`. The demo holds 17 secrets, including a runtime `CLOUDFLARE_API_TOKEN` of unknown scope.
- GitHub `CLOUDFLARE_API_TOKEN` locations:
  - production-environment secrets in WizardGang, SharkTank and Hexframe;
  - a repo-level secret in the demo, alongside a repo-level `CLOUDFLARE_ACCOUNT_ID`.
- **Changed since the audit.** WizardGang WG-116 (merged; released as v1.2.2 by WG-118) removed the SharkTank proxy and redirects from the website Worker. SharkTank's queue (ST-139…ST-220) now plans these changes:
  - ST-144 runs the Room from memory only.
  - ST-146 deletes the operator console, including `opsAuthorized`.
  - ST-148 removes the cron, the backups and the R2 binding.
  - ST-149 deletes the `Lobby` class with a `v2` migration at the `v2.1.0` deploy (ST-166).

**Per-repo migrations (Phase 4).** These are not baseline tasks. Each repo queues its own after the baseline task it depends on has merged.

- **Hexframe** adopts the vendored `wg-edge` shell. It collapses `env.production` into a conforming top-level `wrangler.jsonc` and moves to the BASE-021 deploy workflow. Its `ADMIN_*` secrets are deleted in Phase 1. The Worker name `hexframe` already matches its target.
- **WizardGang** becomes the `wizardgang` Worker with `www` as an alias. It moves to the shared compatibility date and `nodejs_compat`, dropping `assets_navigation_has_no_effect`. It adopts the shell and the deploy workflow, and removes YarReader (19 tracked files on `ad3f0db`). It deletes its Cloudflare token scripts once BASE-022 owns them.
  - The SharkTank proxy removal that was blocked on ST-145 is already done (WG-116). Nothing remains for it.
- **The demo** becomes the `demo` Worker on the shared D1 and R2. That means migrating the useful `demo-blob` rows into `records`/`events` with TTLs and moving the `wizardgang-demo-r2` objects under `demo/`.
  - It moves `CLOUDFLARE_API_TOKEN` from repo level to a `production` environment.
  - It replaces `DEMO_ADMIN_*` with the shell's operator gate and removes them from its `config/worker-secrets.json`, so its secrets match the 17 names declared in `config/cloudflare.json`.
  - DEMO-431 (release and deployment tools) and DEMO-443 (Deploy workflow logic) overlap with BASE-021. Recommended default: the demo re-scopes both to call the reusable workflow instead of porting its own deploy tooling.
- **SharkTank** becomes the `sharktank` Worker at a release boundary. The owner's direction is a rehearsed Durable Object `transferred_classes` migration from `wizardgangprod`. After ST-144 and ST-149, no durable DO state is planned to remain, so the rehearsal must confirm what (if anything) the transfer still carries. The open decision below covers this.
- **YarReader** gets a tombstone (private and archived, like the other retired repos). It has no Cloudflare footprint.

**Open owner decisions, with recommended defaults.**

- **Worker renames:** rename `wizardgang-portfolio`, `wizardgang-architecture-demo` and `wizardgangprod` to their host labels. Default: deploy the new name first, move the custom domain at a release boundary, confirm `/version.json`, then delete the old Worker from the runbook.
- **DO transfer vs restore:** default to `transferred_classes`, rehearsed on a scratch Worker pair, and scheduled after SharkTank `v2.1.0`. If a live read at cut-over shows no stored Room state, a fresh class is an acceptable owner-approved fallback. Restoring from R2 backups stops being an option once ST-148 removes the backups.
- **Moving the demo repo into Wizard-Gang:** default yes, after the demo's current queue drains and before its Phase 4 deploy migration. Then all four deploying repos share the org's rulesets.
- **`www` as a Worker alias:** default yes. `www` becomes a custom domain on the `wizardgang` Worker, the shell 308s it to the apex, and the unmanaged zone redirect rule is removed.
- **Demo read-only usage reporting:** default keep, with a newly minted read-only token declared as a demo secret. The current token of unknown scope is revoked.
- **Starting before other queues drain:** default to starting this queue now, because it touches no consumer repo and no provider. Phase 1 can run at any time. Each repo's Phase 4 migration waits for its repo's current wave: the demo through DEMO-452, SharkTank through `v2.1.0`, and Hexframe's current HF wave.

**Shared defaults for every task.**

- The Cloudflare account ID comes from `CLOUDFLARE_ACCOUNT_ID` at runtime and is never committed.
- Platform code is dependency-free ESM JavaScript with JSDoc types and a hand-written `.d.ts`. It runs on Node 26 for tests and on Workers in consumers, so `npm run check` stays credential-free with no new runtime dependencies.
- Provider-reading commands stay outside `npm run check` and are tested against recorded fixtures.
- `config/cloudflare.json` is the desired Cloudflare state, and `scripts/cloudflare-desired-state.mjs` is its closed validator, enforced by the repository contract. Later tasks read the Workers, hosts, storage names, secret names and settings from it rather than restating them. Its compatibility date is 2026-08-31, the newest live date on 2026-10-03, with `nodejs_compat` as the only flag. The demo declares 17 Worker secret names from `config/worker-secrets.json` on `3693e71`, without `DEMO_ADMIN_*`; the other three Workers declare none. The R2 bucket expires `demo/uploads/` after 1 day, matching the demo's 24-hour visitor uploads.

### BASE-017 — [OPS] Add a read-only Cloudflare drift check

- Dependency: BASE-016 merged.
- Why: The desired state is only useful if live convergence can be proven the same way `verify:github-settings` proves GitHub convergence.
- Scope: Add `npm run verify:cloudflare`. It issues GET calls only, using `CLOUDFLARE_API_TOKEN` (the read-only audit token) and `CLOUDFLARE_ACCOUNT_ID` from the environment.
  - It compares by exact set equality: Worker scripts, custom domains (host → Worker), D1 databases, R2 buckets, KV namespaces, DO namespaces (Worker:class), crons per Worker, secret names per Worker and Secrets Store secret names.
  - It also compares per-Worker settings: compatibility date and flags, observability, workers.dev and preview URLs. R2 lifecycle rules are compared too.
  - Output lists missing, unexpected and mismatched items, then exits non-zero on drift. The token is never printed.
  - Test it with recorded API fixtures, including the 2026-10-03 shape, which must report the expected drift.
  - Add a control-map row.
- Non-goals: No apply or mutate command, no secret values read, no use inside `npm run check` or CI, and no zone, DNS or ruleset reads (the current OAuth scope lacks them).
- Acceptance: Fixture tests prove each category's missing, unexpected and mismatch paths, plus a clean pass. A missing token or account ID fails closed with a distinct message. Read-access failures are reported distinctly.
- Validation: Pinned `npm ci`, focused drift tests, canonical `npm run check`, `npm run audit:dependencies`, `git diff --check` and exact-head CI. One owner-run live invocation is optional and recorded in the PR, not in the repository.
- Authorities: `config/cloudflare.json`, `scripts/verify-github-repository-settings.mjs` (the pattern), `docs/CONTROL-MAP.md` and AGENTS.md commands and credentials.

### BASE-018 — [FEAT] Add the wg-edge Worker shell

- Dependency: BASE-016 merged.
- Why: Four Workers implement host checks, version and health output, admin auth (in three schemes), headers and errors differently. One audited shell removes that divergence.
- Scope: Add `platform/wg-edge/`, a fetch/scheduled wrapper around an app handler:
  - host guard against the Worker's declared hosts, with `www` → apex 308 for `wizardgang`;
  - `/version.json`, `/health.json` and `robots.txt`;
  - the `/admin/*` operator gate, lifted from SharkTank's fail-closed `opsAuthorized` (`src/worker/index.ts` at `a031820`, before ST-146 deletes it):
    - Bearer or Basic over TLS only;
    - constant-time comparison;
    - deny when `WG_OPS_TOKEN` is unset;
  - security headers;
  - JSON or HTML 404s chosen by `Accept`;
  - a top-level error boundary that never leaks stack traces;
  - structured JSON logs;
  - `records` and `events` D1 helpers and an R2 helper, all scoped by `WG_APP` so no app can address another app's rows or keys;
  - a TTL sweeper that deletes expired `records` and `events` rows for its own `WG_APP`, called from the app's scheduled handler.
  - Tests cover every item, using Node `Request`/`Response`, a `node:sqlite`-backed D1 fake and an in-memory R2 fake.
- Non-goals: No product routes, sessions beyond exposing `WG_SESSION_KEY`, DDL, vendoring, wrangler config, deployment, consumer adoption or provider change.
- Acceptance: Tests prove fail-closed admin denial (missing token, plain HTTP, wrong scheme or credential), host rejection, cross-app isolation in D1 and R2, sweeper scoping, error-boundary redaction and both 404 forms.
- Validation: Pinned `npm ci`, focused shell tests, canonical `npm run check`, `npm run audit:dependencies`, `git diff --check` and exact-head CI.
- Authorities: `config/cloudflare.json`, `config/phase.json` platform grant, SharkTank `src/worker/index.ts` at `a031820` and `SECURITY.md`.

### BASE-019 — [DB] Add the universal records and events migration

- Dependency: BASE-018 merged.
- Why: The shared `wizardgang` D1 needs one schema with one owner, so consumers never ship competing DDL.
- Scope: Add `platform/migrations/0001_universal.sql`.
  - `records(app, collection, id, body JSON, owner, created_at, updated_at, expires_at)` with primary key `(app, collection, id)`.
  - `events(app, kind, at, body JSON, expires_at)`.
  - Indexes for owner, expiry and app-time lookups.
  - Test that the migration applies cleanly in `node:sqlite` and matches the columns the BASE-018 helpers use.
  - Extend the repository contract: SQL migrations may exist only under `platform/migrations/`, numbered contiguously, and never edited after merge (a hash pin per merged file).
  - Document that baseline is the only DDL owner for the shared database.
- Non-goals: No live D1 creation or migration apply (the owner does that in Phase 3), no app-specific tables and no data migration.
- Acceptance: A fresh in-memory database built from the migration supports every helper operation. The contract fails on an out-of-sequence, out-of-area or edited migration.
- Validation: Pinned `npm ci`, focused migration and helper tests, canonical `npm run check`, `npm run audit:dependencies`, `git diff --check` and exact-head CI.
- Authorities: `platform/wg-edge/` helpers, `config/cloudflare.json` and `docs/OWNERSHIP.md`.

### BASE-020 — [BUILD] Add the Worker config conformance check and vendoring pin

- Dependency: BASE-019 merged.
- Why: The consolidation only holds if each consumer's `wrangler.jsonc` and vendored shell cannot silently diverge from baseline.
- Scope: Add `platform/wrangler.template.jsonc` and a dependency-free conformance checker. The checker takes the JSONC config and the Worker's entry in `config/cloudflare.json`.
  - Top-level config only: no `env` blocks and no `account_id`.
  - `name` equals the Worker label, and `WG_APP` equals the name.
  - Exactly one route: the declared host as a custom domain. `www` is allowed only for `wizardgang`.
  - `workers_dev` and `preview_urls` are false, observability is on, and the compatibility date and flags are shared.
  - Bindings: only D1 `wizardgang`, only R2 `wizardgang`, no KV, only the declared DO classes and crons, and Secrets Store bindings only for the declared names.
  - Add a vendoring mechanism on the `check-portfolio-contract` pattern. A consumer copies `platform/` into its repo with a lock file listing the baseline source commit and a SHA-256 per file. The vendored checker fails on any edit, missing file or unpinned file. A baseline command prints the lock for a given commit.
- Non-goals: No change to any consumer repository, no deploy workflow and no provider read.
- Acceptance: Fixture tests reject each forbidden shape. They pass the template for each of the four Workers and fail a tampered or partial vendored copy.
- Validation: Pinned `npm ci`, focused conformance and vendoring tests, canonical `npm run check`, `npm run audit:dependencies`, `git diff --check` and exact-head CI.
- Authorities: `config/cloudflare.json`, `scripts/check-portfolio-contract.mjs` (the hash-pin pattern), `platform/wg-edge/` and Hexframe `wrangler.jsonc` at `f95b735` as the current-shape example.

### BASE-021 — [OPS] Add the reusable deploy-worker workflow

- Dependency: BASE-020 merged.
- Why: Each repo deploys differently, with different token placement. One reusable workflow gives every Worker the same tag-to-production path and the same identity proof.
- Scope: Add `.github/workflows/deploy-worker.yml`, triggered only by `workflow_call`, with these steps:
  1. Check out the caller's annotated semantic tag. Require the tag to match `package.json` and point to the expected commit.
  2. Run `npm ci` and `npm run check`, then the vendored conformance and pin checks.
  3. Build, then run `wrangler deploy` (wrangler pinned by the caller's lockfile) in a job bound to the caller's `production` environment, so only environment-scoped `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are used.
  4. Confirm that the new version serves 100% of traffic.
  5. Poll the public `https://<host>/version.json` until it reports the tag and commit, and fail on timeout.
  - Actions are pinned by SHA with least-privilege permissions. Literal run blocks pass `check-workflow-shell`.
  - Extend the repository contract so the workflow has no trigger that runs in baseline itself, and baseline never deploys.
  - Document the call snippet for consumers.
- Non-goals: No consumer adoption, no secrets, environments or settings changes, and no first deploy. Rollback stays a later decision, recorded in the runbook as redeploying the previous tag.
- Acceptance: Contract tests prove the call-only trigger, the environment binding, the pinned actions, the 100% check and the `/version.json` identity check. No baseline workflow can deploy.
- Validation: Pinned `npm ci`, focused workflow-contract and workflow-shell tests, canonical `npm run check`, `npm run audit:dependencies`, `git diff --check` and exact-head CI.
- Authorities: `.github/workflows/`, `scripts/repository-contract.mjs`, `scripts/check-workflow-shell.mjs`, `docs/RELEASE-MANAGEMENT.md` and the demo's DEMO-431 and DEMO-443 scope (for the overlap note).

### BASE-022 — [SEC] Move Cloudflare token rotation and discovery into baseline

- Dependency: BASE-016 merged.
- Why: The token rotation and discovery scripts live in a product repo (WizardGang). They update repo-level secrets as well, which keeps the demo's repo-level token alive.
- Scope: Bring `scripts/discover-cloudflare-api-token-targets.sh` and `scripts/rotate-cloudflare-api-token.sh` from WizardGang `ad3f0db` into baseline.
  - Default: port them to Node ESM, so `npm run check` can test them with a stubbed `gh`.
  - Derive targets from the repositories and `production` environments declared in `config/cloudflare.json`.
  - Write only production-environment secrets. Report any repo-level `CLOUDFLARE_API_TOKEN` as drift and never update it.
  - Read the new value from stdin only, pass it to `gh secret set` over stdin, and never print it. Re-read `updatedAt` after each write.
  - Add `discover:cloudflare-token-targets` and `rotate:cloudflare-token` npm scripts.
- Non-goals: No rotation run, no secret, environment or token mutation, and no deletion of the WizardGang copies (WizardGang's own Phase 4 task does that).
- Acceptance: Stubbed-`gh` tests prove that targets come only from the config. They also prove repo-level secrets are reported and never written, values never appear in argv or output, and a failed write or re-read fails the run.
- Validation: Pinned `npm ci`, focused rotation and discovery tests, canonical `npm run check`, `npm run audit:dependencies`, `git diff --check` and exact-head CI.
- Authorities: WizardGang `scripts/*cloudflare-api-token*.sh` at `ad3f0db`, `config/cloudflare.json`, AGENTS.md commands and credentials, and `SECURITY.md`.

### BASE-023 — [DOCS] Write the Cloudflare provider runbook

- Dependency: BASE-017, BASE-019, BASE-021 and BASE-022 merged.
- Why: The owner performs every provider mutation. Each step needs exact preconditions, commands, read-back and rollback, so it can be done safely from the Mac.
- Scope: Add `docs/CLOUDFLARE-RUNBOOK.md` and link it from the README and the control map. Each step lists a fresh read-only precondition (using `verify:cloudflare` where possible), the mutation, the read-back and the rollback.
  - Phase 1 deletes:
    - the `wizardgang-portfolio-staging` Worker;
    - the D1 database `wizardgang-demo-data`;
    - the R2 bucket `wizardgang-demo-r2-preview`;
    - the KV namespaces `wg-gateway-status-dev` and `wg-gateway-status-prod`;
    - Hexframe's `ADMIN_*` Worker secrets, after proving its `origin/main` no longer reads them.
  - Phase 3 provisioning:
    - create D1 `wizardgang` and apply `0001_universal.sql`;
    - create R2 `wizardgang` with its lifecycle rules;
    - add `WG_OPS_TOKEN` and `WG_SESSION_KEY` to the Secrets Store;
    - mint the scoped deploy token, with its minimum permissions listed, and set it into each production environment with `rotate:cloudflare-token`;
    - mint the read-only audit token for `verify:cloudflare`.
  - Later retirements, each gated: `wizardgang-demo-assets` after SharkTank ST-148 is deployed; `demo-blob` and `wizardgang-demo-r2` after the demo's data migration; old Worker names after each rename is verified; the `www` zone rule after the alias serves; the demo's old runtime token.
- Non-goals: No mutation by an agent, no token values and no account ID in the document.
- Acceptance: Every Phase 1 and Phase 3 step has a precondition, a command, a read-back and a rollback. The document names nothing outside `config/cloudflare.json` and the 2026-10-03 inventory. Documentation tests keep its links and command names current.
- Validation: Pinned `npm ci`, documentation tests, canonical `npm run check`, `npm run audit:dependencies`, `git diff --check` and exact-head CI.
- Authorities: `config/cloudflare.json`, `npm run verify:cloudflare`, `platform/migrations/`, the rotation scripts, this plan's preamble and the 2026-10-03 live read.
