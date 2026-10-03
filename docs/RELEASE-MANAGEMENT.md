# Release management

`package.json` owns the version. A version change is a controlled PR; an annotated `vMAJOR.MINOR.PATCH` tag identifies the accepted `main` commit for that version. Published tags never move or disappear. A release correction uses a new controlled change and version. This seed has no deployment target; releasing publishes the reference contract and its provenance, not an application. Shared edge code under the `platform/` grant is released only as part of that source; consuming repositories vendor and deploy it through their own controlled release paths, and baseline never deploys a Worker itself. Those paths call the reusable [`deploy-worker.yml`](../platform/deploy/README.md), whose only trigger is `workflow_call`; it runs in the caller's repository against the caller's annotated tag and `production` environment.

## Tag gate

After merged `main` and its post-merge CI are verified, Release Cutter creates or verifies the annotated semantic tag at the exact accepted commit. It explicitly dispatches Release at the tag ref with that commit because a tag pushed with the workflow token does not trigger another workflow. A later same-version merge never moves the tag. The tag ruleset blocks updates and deletions. The Release workflow also accepts an intentional tag push and independently proves:

- the tag name is exact semantic `vX.Y.Z`, its Git object type is `tag`, and it resolves to checked-out `HEAD`;
- the commit is reachable from current `main` and its `package.json` version equals the tag;
- a clean checkout with the pinned toolchain passes `npm ci`, `npm run check`, and `npm run audit:dependencies`;
- a source archive reproduced from that tag has the same SHA-256 in two clean jobs.

The release workflow is serialized per tag and never canceled mid-publication. The explicit dispatch stays on the tag ref so the attestation binds to that ref. Its verification job has read-only permissions. The publication job receives only `contents: write`, `id-token: write`, and `attestations: write`. It creates the deterministic `baseline-vX.Y.Z.tar.gz` archive using `git archive` and `gzip -n`, and a `SHA256SUMS` file. It checks the manifest before publication and generates a GitHub provenance attestation bound to the tag ref, source commit, repository, and signer workflow.

## Retry-safe publication

Publication is a state reconciliation, not a blind create call. An absent Release becomes a draft. A matching draft may receive only missing assets whose expected SHA-256 is known; an existing mismatched asset fails closed. Once both assets, their digests, and the artifact attestation verify, the draft is published. A rerun against a matching published immutable Release validates its tag, asset names/digests, GitHub Release attestation, and artifact attestation, then exits successfully without editing it. A published mismatch or a tag pointing to a different commit is an incident requiring a forward correction. No rerun moves a tag or uses `--clobber`.

The GitHub Release and annotated tag are the historical release authority. Generated notes derive from GitHub history; there is no hand-maintained version ledger. Before merging a version change, run the separate live provider settings verification with Repository Administration read access and confirm immutable Releases are enabled. The committed settings authority requires and can enable that policy. GitHub applies immutability only to future publications, so a Release published while it was disabled needs a new controlled version. The release workflow verifies the immutable state and downloaded asset identity after publishing. A successful workflow run URL, tag object, Release URL, SHA manifest, and attestation form the release evidence.

## Reproduce and inspect

From a clean checkout of an existing release tag:

```sh
npm ci
npm run check
npm run audit:dependencies
npm run check:release -- identity --tag v0.1.0
mkdir -p dist
git archive --format=tar --prefix=baseline-v0.1.0/ v0.1.0 | gzip -n > dist/baseline-v0.1.0.tar.gz
sha256sum dist/baseline-v0.1.0.tar.gz
```

Compare that digest with the GitHub Release asset and `SHA256SUMS`, then verify its GitHub attestation with the exact repository, tag ref, source commit, and signer workflow. `gh release verify` and `gh release verify-asset` check GitHub's immutable Release provenance. Report the exact command, digest, run, and any unavailable provider check. There is no application deployment or rollback in this seed itself.

## Consumer Worker deployment

`.github/workflows/deploy-worker.yml` is the shared Worker deployment policy; [`platform/deploy/README.md`](../platform/deploy/README.md) documents the call. A consumer calls it with its Worker label, its annotated release tag and that tag's commit. Before any credential is reachable, the workflow proves that the tag is annotated exact `vX.Y.Z`, matches `package.json` and points to the expected commit on `main`. It then reruns `npm ci` and `npm run check` and checks the vendored `platform/` pin and the `wrangler.jsonc` conformance. Only then does a job bound to the caller's `production` environment, holding only `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, run the caller's locked `wrangler deploy` with resource provisioning off. It finishes only when the new version serves 100% of traffic and the public `/version.json` reports the tag's version and commit. A timeout fails the run. Rollback is a redeploy of the previous release tag through the same workflow; nothing moves a tag or uses `wrangler rollback`. The repository contract fails any trigger other than `workflow_call`, any baseline workflow that calls the deploy or runs wrangler, and any wrangler dependency, config or package script in baseline.
