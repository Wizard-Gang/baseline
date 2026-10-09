# deploy

One tag-to-production path for every Worker. Baseline hosts the reusable workflow [`.github/workflows/deploy-worker.yml`](../../.github/workflows/deploy-worker.yml) but never runs it. Its only trigger is `workflow_call`, and the repository contract fails any other trigger, any baseline workflow that calls it, any wrangler config or dependency in baseline, and any baseline script or workflow that runs wrangler. `evidence.mjs` proves the caller's reproduction from the Actions API, and `verify.mjs` holds the production checks and the result. Consumers vendor both with the rest of `platform/`, and `pin` covers them.

## What the workflow proves

The `verify` job holds no secrets and binds no environment. Its token may read only Actions and contents:

1. It checks out `refs/tags/<tag>`. The tag must be exact semantic `vX.Y.Z` and annotated. It must point to `expected_sha` on the caller's `main`, and `package.json` must hold the same version.
2. It runs `node platform/deploy/verify.mjs evidence`, which proves the caller's reproduction from the run's own identity (`GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`) and its `github.token`, never from an input:
   - the current run belongs to the caller's repository (not a fork), is at `expected_sha` on the tag or `main`, was started by `push` or `workflow_dispatch`, is in this attempt, and references exactly one `deploy-worker.yml` commit, which equals the vendored `platform/vendor.lock.json` commit;
   - the run's workflow, read from the checkout at `expected_sha`, has exactly one job that calls `deploy-worker.yml`. That job needs, directly or through other needs, exactly one job that sets up Node from `.node-version` and runs `npm ci` and then `npm run check`, with no `continue-on-error`, no conditional step and no checkout of another commit;
   - the attempt's jobs list holds exactly one job of that name, `completed`/`success` at `expected_sha` in this attempt;
   - the tag has a published, non-draft GitHub Release.

   Each read is one bounded GET; a failure reports only its HTTP status, never a body or the token. Missing, unreadable or mismatched evidence fails the run, and nothing falls back to running `npm run check` here. The caller's job is the one acceptance run.
3. It runs `node platform/conformance/cli.mjs pin` and `node platform/conformance/cli.mjs wrangler --worker <label>`. It installs nothing and builds nothing.

Only then does the `deploy` job start, bound to the caller's `production` environment:

1. It rebinds the tag to the verified commit, installs the same npm and runs `npm ci`.
2. It runs `npm run build --if-present` with `WG_VERSION` (the tag without its `v`) and `WG_COMMIT` (the full commit) in the environment, for the build to pass to `createEdge`.
3. It runs `npx --no-install wrangler deploy --experimental-provision=false --experimental-auto-create=false --var "CLOUDFLARE_ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID"`. The account ID is never committed, so this var is how a Worker reads it at runtime (for example, the demo's usage report); conformance rejects a committed `vars.CLOUDFLARE_ACCOUNT_ID`. That is the wrangler in the caller's lockfile with resource provisioning off. In wrangler 4.147, provisioning creates a D1 database named in the config even when auto-create is off. With provisioning off, a binding wrangler cannot resolve fails the deploy instead, so a deploy can never create D1 `wizardgang` (or any other resource) before Phase 3. A consumer that binds `WG_DB` therefore commits the database's UUID `database_id`, which the owner records when creating it.
4. It confirms with `wrangler deployments status --json` that the Worker Version ID wrangler reported is the only version and serves 100% of traffic, retrying for about a minute.
5. It runs `node platform/deploy/verify.mjs observe` once:
   - it polls `https://<host>/version.json` until `app`, `version` and `commit` equal the label, the tag version and the tag commit. The default timeout is 5 minutes. A Cloudflare managed challenge to the runner is a failed attempt, and a run that ends behind one says so, apart from a plain timeout. Waiting never deploys again;
   - `/health.json` must answer 200 with `status` `ok`, the label and the tag version;
   - the root page, after at most three same-origin redirects, must be HTML, and each same-origin script, module preload and stylesheet it names (at most 20) must answer 200 with a JavaScript or CSS type and a non-empty body. This is an availability check, not a browser suite.

   The host comes from the vendored `desired.mjs`, never from an input. Only when every observation passes does it write the result, and the step exports it as the job output and the workflow output `result`.

## The result

`result` is one line of JSON holding exactly these fields, each checked against its shape before it is written: `schema` (1), `worker`, `host`, `repository`, `run_id`, `run_attempt`, `tag`, `commit` (full), `observed_at` (ISO UTC), `worker_version_id` (the Wrangler Version ID), `traffic_percentage` (100), `assets_checked`, and `checks` with `reproduction`, `traffic`, `version`, `health` and `assets` all `passed`. Any other field, such as an account ID, a credential or raw provider output, is refused, and a failed run has no result.

The deploy job reads only the secret `CLOUDFLARE_API_TOKEN` and the variable `vars.CLOUDFLARE_ACCOUNT_ID`, as `config/secrets.json` registers them, and it fails before wrangler runs if either is empty. Only the `verify` job adds `actions: read` to the read-only token, to read the run's own evidence; the `deploy` job keeps `contents: read` and never reads the GitHub token. Actions are pinned by commit SHA, and inputs reach the shell only through `env`. Runs are serialized per Worker and never cancelled mid-deploy.

## Calling it

A consumer calls the workflow from its own release path, after its Release has published the annotated tag, from a job that `needs`, directly or through other needs, the one job reproducing the tag in the same run. If a run would rerun failed jobs only, rerun all jobs, so the reproduction belongs to the new attempt. Pin the workflow to the merged baseline commit its `platform/vendor.lock.json` names. Pass the tag and its commit, grant the calling job `actions: read` and `contents: read`, and pass `secrets: inherit`. The run must itself be at the tag commit: a dispatch from `main` that deploys an older tag has no reproduction of that tag and fails. A called workflow sees only the secrets its caller passes: binding the caller's `production` environment inside the `deploy` job does not expose that environment's secrets on its own, so without `inherit` the job reads an empty `CLOUDFLARE_API_TOKEN` and fails before wrangler runs. Variables need no passing. GitHub allows `inherit` only within one organization, so the caller must be a `Wizard-Gang` repository. The workflow still declares no secrets, the `verify` job reads none, and the `deploy` job reads only `CLOUDFLARE_API_TOKEN`, which the registry keeps in the caller's `production` environment, never at repository level.

```yaml
jobs:
  deploy:
    needs: reproduce
    permissions:
      actions: read
      contents: read
    uses: Wizard-Gang/baseline/.github/workflows/deploy-worker.yml@<merged baseline commit>
    secrets: inherit
    with:
      worker: hexframe
      tag: ${{ github.ref_name }}
      expected_sha: ${{ github.sha }}
```

The caller needs these in place:

- `platform/` vendored with its `vendor.lock.json`, and a conforming `wrangler.jsonc` at the root;
- `.node-version` and an exact `packageManager` npm pin;
- `wrangler` in its lockfile, plus `npm run check` (and optionally `npm run build`);
- one job the call needs that sets up Node from `.node-version` and runs `npm ci` and then `npm run check` on the tag, and a published Release for the tag before the call;
- a `production` environment holding the secret `CLOUDFLARE_API_TOKEN` and the variable `CLOUDFLARE_ACCOUNT_ID` (a variable, never a secret), and a token that may bind Secrets Store secrets;
- a Worker that serves the wg-edge `/version.json` and `/health.json`.

The caller reads `needs.<job>.outputs.result` after a successful deploy.

## Checks

```sh
node platform/deploy/verify.mjs host --worker <label>
node platform/deploy/verify.mjs evidence --worker <label> --tag <vX.Y.Z> --commit <sha>
node platform/deploy/verify.mjs traffic --worker <label> --deploy-output <ndjson> --status <json>
node platform/deploy/verify.mjs observe --worker <label> --tag <vX.Y.Z> --commit <sha> --deploy-output <ndjson> --status <json> --result <path> [--timeout <s>] [--interval <s>]
```

Exit codes are 0 for verified, 1 for not verified and 2 for a usage error. `evidence` reads only the GitHub API for the current run; `observe` reads only the Worker's public host.

## Rollback

Rollback means redeploying the previous release tag through this same workflow, from a caller run at that tag, so that run reproduces it. The workflow never runs `wrangler rollback` and never moves a tag. The owner's runbook records this.
