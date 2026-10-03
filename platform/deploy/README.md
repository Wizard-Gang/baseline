# deploy

One tag-to-production path for every Worker. Baseline hosts the reusable workflow [`.github/workflows/deploy-worker.yml`](../../.github/workflows/deploy-worker.yml) but never runs it. Its only trigger is `workflow_call`, and the repository contract fails any other trigger, any baseline workflow that calls it, any wrangler config or dependency in baseline, and any baseline script or workflow that runs wrangler. `verify.mjs` holds the post-deploy identity checks. Consumers vendor it with the rest of `platform/`, and `pin` covers it.

## What the workflow proves

The `verify` job holds no secrets and binds no environment:

1. It checks out `refs/tags/<tag>`. The tag must be exact semantic `vX.Y.Z` and annotated. It must point to `expected_sha` on the caller's `main`, and `package.json` must hold the same version.
2. It installs the npm pinned by `packageManager`, then runs `npm ci` and `npm run check`.
3. It runs `node platform/conformance/cli.mjs pin` and `node platform/conformance/cli.mjs wrangler --worker <label>`.

Only then does the `deploy` job start, bound to the caller's `production` environment:

1. It rebinds the tag to the verified commit, installs the same npm and runs `npm ci`.
2. It runs `npm run build --if-present` with `WG_VERSION` (the tag without its `v`) and `WG_COMMIT` (the full commit) in the environment, for the build to pass to `createEdge`.
3. It runs `npx --no-install wrangler deploy --experimental-provision=false --experimental-auto-create=false`. That is the wrangler in the caller's lockfile with resource provisioning off. In wrangler 4.147, provisioning creates a D1 database named in the config even when auto-create is off. With provisioning off, a binding wrangler cannot resolve fails the deploy instead, so a deploy can never create D1 `wizardgang` (or any other resource) before Phase 3. A consumer that binds `WG_DB` therefore commits the database's UUID `database_id`, which the owner records when creating it.
4. It confirms with `wrangler deployments status --json` that the version wrangler reported serves 100% of traffic, retrying for about a minute.
5. It polls `https://<host>/version.json` until `app`, `version` and `commit` equal the label, the tag version and the tag commit. The default timeout is 5 minutes, and it fails on timeout. The host comes from the vendored `desired.mjs`, never from an input. A Cloudflare managed challenge to the runner counts as a failed attempt, not a pass.

The deploy job reads only `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and it fails before wrangler runs if either is empty. Neither job widens the read-only token. Actions are pinned by commit SHA, and inputs reach the shell only through `env`. Runs are serialized per Worker and never cancelled mid-deploy.

## Calling it

A consumer calls the workflow from its own release path, after its Release has published the annotated tag. Pin the workflow to a merged baseline commit. Pass the tag and its commit. Do not pass secrets and never use `secrets: inherit`. The workflow declares no secrets, so the job reads the two Cloudflare secrets from the caller's `production` environment, never from repository-level secrets.

```yaml
jobs:
  deploy:
    permissions:
      contents: read
    uses: Wizard-Gang/baseline/.github/workflows/deploy-worker.yml@<merged baseline commit>
    with:
      worker: hexframe
      tag: ${{ github.ref_name }}
      expected_sha: ${{ github.sha }}
```

The caller needs these in place:

- `platform/` vendored with its `vendor.lock.json`, and a conforming `wrangler.jsonc` at the root;
- `.node-version` and an exact `packageManager` npm pin;
- `wrangler` in its lockfile, plus `npm run check` (and optionally `npm run build`);
- a `production` environment holding `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`;
- a Worker that serves the wg-edge `/version.json`.

## Checks

```sh
node platform/deploy/verify.mjs host --worker <label>
node platform/deploy/verify.mjs traffic --worker <label> --deploy-output <ndjson> --status <json>
node platform/deploy/verify.mjs version --worker <label> --version <X.Y.Z> --commit <sha> [--timeout <s>] [--interval <s>]
```

Exit codes are 0 for verified, 1 for not verified and 2 for a usage error. Only `version` reads the network, and only the Worker's public host.

## Rollback

Rollback means redeploying the previous release tag through this same workflow, with that tag and its commit. The workflow never runs `wrangler rollback` and never moves a tag. The owner's runbook records this.
