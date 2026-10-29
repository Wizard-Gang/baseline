# Change management

This is the canonical way `baseline` accepts and merges a change; [AGENTS.md](../AGENTS.md) is the shared portfolio contract it implements. Every delivered task gets one permanent `BASE-###` ID, and a `[PLAN]` change takes none. The root `BASE-001` bootstrap commit precedes provider protection; every later change follows the controlled PR path. GitHub's merged PRs, checks and Releases are the only delivery record.

## Authority and sequence

Fetch `main` and the open release branch, inspect open PRs and current CI, then read `implementation_plan.md`. Its first open task is next. A delivering PR removes its own task, and the last one leaves the tracked empty template. A blocked task stays first until its prerequisite is resolved or a plan edit reorders the queue. Do not start a duplicate PR.

Plan edits are free: any PR may add, edit, reorder or remove queued tasks from any queue state. A PR that changes only the plan is `[PLAN] Imperative summary` on branch `plan-imperative-summary`. The plan records `**Highest ID ever used:** BASE-###.`; a new task takes an ID above it and raises it, a removed queued ID stays retired, and IDs need not be contiguous. `validateQueueEdit` in `contract/check-portfolio-contract.mjs` holds these rules.

IDs are unique, permanent and never recycled. A correction or revert takes a new ID and cites the affected change in its body. Task branches are `base-NNN-imperative-summary`. Task PR titles and commit subjects are exactly `[BASE-NNN] [TYPE] Imperative summary`, with the same ID, type and subject; a release PR is `[RELEASE] rNNN: BASE-0xx..BASE-0yy`. Types: `INIT`, `FEAT`, `FIX`, `SEC`, `API`, `A11Y`, `I18N`, `AI`, `DB`, `OPS`, `TEST`, `DOCS`, `REFACTOR`, `PERF`, `BUILD`, `REVERT`, `CHORE`.

The one commit in a task or plan PR carries ordered, nonempty fields:

```text
[BASE-###] [TYPE] Imperative summary

Change:
What changed.

Reason:
Why it changed.

Impact:
What boundary or behavior is affected.

Risk:
Low
Concrete exposure. Use Medium or High when appropriate.

Controls:
How the risk is constrained or reversed.

Validation:
Checks actually run and their results.

Evidence:
Relevant paths, run URLs, or exact provider observations.

Source:
Direct work or the source commit/issue used.

Release:
The intended version or Unreleased.
```

Risk is low for policy prose with no control change, medium for build and process behavior, and high for authentication, permissions, secrets, protected history, release publication, or destructive effects. High-risk changes name a rollback or forward correction and its authority. Do not backfill unobserved validation.

## Acceptance path

1. Branch from the exact tip of the open `release/rNNN` named in `config/release.json`, cutting it from main's tip when none is open. Implement one task, remove its plan block and append its ID to `config/release.json` `tasks` in the same commit. Keep one controlled commit in the PR range.
2. Run pinned `npm ci`, the non-test checks (`check:change`, `check:repository`, `check:workflow-shell`), `npm run audit:dependencies`, `PATCH_BASE_SHA=<full-base> PATCH_HEAD_SHA=<full-head> npm run check:patch` and `git diff --check`. CI runs the tests. The patch check uses the committed range; a working-tree `git diff --check` alone does not prove it. The immutable commit and matching PR body contain only evidence known at authoring time or explicitly marked pending.
3. Open the PR into the release branch. Its body must equal the controlled commit body. CI checks out the event's exact `pull_request.head.sha`; `change-id` validates the title, branch, subject, body, one-commit range and queue edit, and the fast `gate` runs the non-test contracts. An independent review on a cheaper model, briefed with the task block, the diff and the named sections, precedes the squash.
4. Before merging, re-fetch the PR and its base, record the exact head SHA, its required check conclusions and mergeability. A changed base or head requires a fresh exact-head check. Diagnose failed jobs from their complete logs for the exact run attempt.
5. Squash only the validated head, with the squash subject and body set to the controlled record. Confirm one controlled commit on the release branch and the task branch deleted.
6. Only on the owner's "release", open the release PR into `main`. `verify` runs every test and the patch, `security` audits dependencies and `change-id` checks each commit; all three must pass on the exact head, current with `main`. Rebase-merge that head, then confirm main's tree, post-merge CI, the release branch deleted and a clean worktree. [RELEASE-MANAGEMENT.md](RELEASE-MANAGEMENT.md) governs the tag and Release that follow. Report a missing check as missing, even if the merge succeeded.

No ordinary direct push, force push or deletion of `main` or a release branch is permitted. The provider contract is committed in `config/github-repository-settings.json`. `npm run verify:github-settings` reads live repository merge settings and rulesets; `npm run apply:github-settings` changes only those committed controls and independently reads them back. CI has read-only repository permissions. The release job alone receives scoped write and OIDC/attestation permissions when a release is explicitly authorized. The rulesets have no bypass actors. The repository's actual plan or provider capability must be checked live before asserting enforcement.

`node --test tests/*.test.mjs` guards history/plan/PR identity, the shared portfolio contract, repository workflow structure and permissions, provider policy comparison, and release identity/publication. A test passing in CI does not replace provider verification.
