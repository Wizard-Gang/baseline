# baseline

`baseline` is the WizardGang change-management reference implementation. It contains governance, executable repository contracts, CI, provider policy, and a release path. It intentionally contains no application or product code.

The contract gate is `npm ci && npm run check && npm run audit:dependencies`. A controlled change then requires an exact-head pull request, current required checks, a squash merge, and post-merge verification. Successful exact-current-main CI cuts or verifies an annotated semantic tag and explicitly dispatches Release at that tag; the source and assets must reproduce. [Change management](docs/CHANGE-MANAGEMENT.md), [release management](docs/RELEASE-MANAGEMENT.md), and [ownership](docs/OWNERSHIP.md) define the operating sequence.

[The control map](docs/CONTROL-MAP.md) lists every committed guard, its authority, and the evidence needed to verify it. Repository auto-merge is available for an individually configured PR; required checks, squash-only merge, and the controlled record still govern that PR.

`config/phase.json` keeps application development disabled. The repository can become an application seed only after the contract has passed local tests and a live provider exercise covering a PR, merge, tag, immutable GitHub Release, asset digest, and provenance attestation. Until that proof exists, changes should improve this reference implementation only.

## Authority

1. Git source, test assertions, workflow files, and committed configuration define executable contracts.
2. `config/github-repository-settings.json` is the desired GitHub provider state; live readback is required to claim convergence.
3. Current-state policy documents describe responsibilities and intent.
4. Git first-parent history, pull requests, workflow runs, annotated tags, Releases, and attestations are the historical evidence. The repository does not keep a parallel release ledger.

The Node and npm versions are pinned by `.node-version` and `package.json`. `package.json` owns the release version. Any future application versioning authority must be introduced by a controlled change before product code is added.

## Start here

```sh
npm ci
npm run check
npm run audit:dependencies
```

`npm run check` needs no GitHub credential. Live provider checks use `GH_ADMIN_TOKEN`, or `GH_TOKEN` when it has the required permissions. `npm run verify:github-settings` only reads repository metadata and rulesets; `npm run apply:github-settings` changes only the committed merge settings and rulesets, then independently re-reads them. Keep the token in process or provider secret state and never print it.
