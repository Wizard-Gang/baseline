# baseline

`baseline` is the WizardGang change-management reference implementation. It contains governance, executable repository contracts, CI, provider policy, and a release path. It intentionally contains no application or product code. Its one code grant is `platform/`, which may hold shared edge code that consuming repositories vendor; baseline has no deployment target and never deploys a Worker itself.

The contract gate is `npm ci && npm run check && npm run audit:dependencies`. A controlled change then requires an exact-head pull request, current required checks, a squash merge, and post-merge verification. Successful exact-current-main CI cuts or verifies an annotated semantic tag and explicitly dispatches Release at that tag; the source and assets must reproduce. [Change management](docs/CHANGE-MANAGEMENT.md), [release management](docs/RELEASE-MANAGEMENT.md), and [ownership](docs/OWNERSHIP.md) define the operating sequence.

[The control map](docs/CONTROL-MAP.md) lists every committed guard, its authority, and the evidence needed to verify it. Repository auto-merge is available for an individually configured PR; required checks, squash-only merge, and the controlled record still govern that PR.

`config/phase.json` keeps application development disabled and declares the `platform` grant: path `platform/`, shared edge code only. The repository contract accepts `platform/` only under that exact grant and keeps rejecting the application paths `src`, `app`, `apps`, `game`, `pages`, `public`, `workers` and `functions`. The repository can become an application seed only after the contract has passed local tests and a live provider exercise covering a PR, merge, tag, immutable GitHub Release, asset digest, and provenance attestation. Until that proof exists, changes should improve this reference implementation only.

## Authority

1. Git source, test assertions, workflow files, and committed configuration define executable contracts.
2. `config/github-repository-settings.json` is the desired GitHub provider state; live readback is required to claim convergence.
   `config/cloudflare.json` is the desired Cloudflare state for the four `wizardgang.ai` Workers. `scripts/cloudflare-desired-state.mjs` keeps it exact and closed during `npm run check`; it holds names only, never an account ID, binding ID or secret value, and claims intent, not live convergence. `npm run verify:cloudflare` is the separate read-only live comparison.
3. Current-state policy documents describe responsibilities and intent.
4. Git first-parent history, pull requests, workflow runs, annotated tags, Releases, and attestations are the historical evidence. The repository does not keep a parallel release ledger.

The Node and npm versions are pinned by `.node-version` and `package.json`. `package.json` owns the release version. Any future application versioning authority must be introduced by a controlled change before product code is added.

## Start here

```sh
npm ci
npm run check
npm run audit:dependencies
```

`npm run check` needs no GitHub credential. Live provider checks use `GH_ADMIN_TOKEN`, or `GH_TOKEN` when it has the required permissions. `npm run verify:github-settings` only reads repository metadata, immutable Releases, and rulesets; `npm run apply:github-settings` changes only the committed merge settings, immutable Releases, and rulesets, then independently re-reads them. Keep the token in process or provider secret state and never print it.

[`platform/wg-edge/`](platform/wg-edge/README.md) is the shared Worker shell: host guard, TLS rule, `/version.json`, `/health.json`, `robots.txt`, the fail-closed `/admin/*` operator gate, security headers, Accept-driven 404s, a redacting error boundary, structured logs, and D1/R2 helpers and a TTL sweeper scoped by `WG_APP`. It is dependency-free ESM with a hand-written `index.d.ts`, and `npm run check` tests it on Node with a `node:sqlite` D1 fake and an in-memory R2 fake. Baseline ships no Worker config and deploys nothing.

[`platform/migrations/`](platform/migrations/0001_universal.sql) is the schema of the shared `wizardgang` D1 database, and baseline is its only DDL owner. `0001_universal.sql` creates `records` and `events` as STRICT tables with JSON-text bodies, integer-millisecond times and indexes for owner, expiry and app-time lookups. The wg-edge D1 fake is built from these files, so every helper test runs against the real schema. The repository contract allows SQL only as `platform/migrations/NNNN_name.sql`, numbered contiguously from `0001`, with each file SHA-256 pinned in `platform/migrations/pins.json` in the commit that adds it. `npm run check:patch` fails a patch that re-pins or drops a merged migration. Consumers ship no DDL. The owner creates the database and applies migrations from the runbook; no baseline command or workflow touches live D1.

`npm run verify:cloudflare` compares live Cloudflare with `config/cloudflare.json`. It needs runtime `CLOUDFLARE_API_TOKEN` (the read-only audit token) and `CLOUDFLARE_ACCOUNT_ID`, issues GET requests only, never reads secret values and never prints the token. It lists missing, unexpected and mismatched items and exits 0 when converged, 1 on drift, 2 when credentials are missing or malformed, 3 when read access is denied and 4 for an invalid authority or any other API failure. It is owner-run: neither `npm run check` nor any workflow calls it, and its tests use recorded API fixtures.
