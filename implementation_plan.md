# Implementation plan

## Open tasks

### BASE-041 — [OPS] Host the owner's agent tooling and link this Mac to it

- Dependency: None.
- Why: Claude Code and Codex in every WizardGang repository depend on files that exist only in untracked folders on the owner's Mac, with no history, review or tests: the PreToolUse guards in `~/.agent-hooks` (`no-tests`, `context-budget`, `rulebook-cap`), the owner rulebook at `~/.claude/CLAUDE.md` (which `~/.codex/AGENTS.md` symlinks to), the reasons for its rules in `~/.agent-hooks/RULEBOOK-WHY.md`, and the `lab-reviewer` subagent at `~/.claude/agents/lab-reviewer.md`. On 2026-10-28 the owner made baseline their home, linked by symlinks to this checkout.
- Scope:
  - `agent/hooks/` holds `no-tests.mjs`, `context-budget.mjs`, `rulebook-cap.mjs`, `no-tests.json`, `context-budget.json` and their README, moved from `~/.agent-hooks` with no change to behavior or thresholds. The hooks resolve machine state (`state/`, `context-budget.allow`) under `~/.agent-hooks/` from the home directory, never from the script's real path, so nothing is ever written into the checkout.
  - `agent/RULEBOOK.md`, `agent/RULEBOOK-WHY.md` and `agent/claude/agents/lab-reviewer.md` hold the rulebook, its reasons and the reviewer. `rulebook-cap` caps the 700 words on every path that resolves to `agent/RULEBOOK.md`.
  - An owner-run `npm run link:agent` prints its plan. With `--apply` it symlinks each tracked hook file into `~/.agent-hooks/`, `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` to `agent/RULEBOOK.md`, and `~/.claude/agents/lab-reviewer.md` to the tracked agent, then re-reads every link. It replaces an existing regular file only when its bytes equal the tracked file, and otherwise stops and names it, so no local edit is lost. It never touches `~/.claude/settings.json`, `~/.codex/hooks.json`, `state/` or the allow file.
  - The README and the control map name the new paths, the link command and its rollback (remove the links and restore the copies).
- Non-goals: no change to hook decisions, thresholds, the enabled repositories, `settings.json` hook wiring or any repository's process (BASE-042 and BASE-043 own those). No workflow runs `link:agent`.
- Acceptance:
  - The hooks give the same decisions as before on the same payloads: tests denied through `Bash`, `Monitor` and `mcp__terminal__run_in_terminal` in the enabled repositories, the heredoc and `<REPO>_ALLOW_TESTS=1` exceptions, the 200k reminder, the 300k block with git, PR, CI-wait and handoff exceptions, the owner override, and the 700-word cap.
  - After `npm run link:agent -- --apply` on a temporary home, every link resolves into the checkout and no state lands in it. A conflicting local file stops the run unchanged.
  - `npm run check` passes.
- Validation: Pinned `npm ci`, a focused `tests/agent-tooling.test.mjs` covering every decision above and the link plan on a temporary home, `npm run check`, `npm run audit:dependencies`, `check:patch`, `git diff --check` and exact-head CI.
- Authorities: `~/.agent-hooks/` and its README, `~/.claude/CLAUDE.md`, `~/.claude/agents/lab-reviewer.md`, `docs/CONTROL-MAP.md` and `README.md`.

### BASE-042 — [DOCS] Make the lab delivery process the shared portfolio contract

- Dependency: BASE-041, so the contract can name the tracked tooling.
- Why: MapLab, RenderLab and RigLab have cut cost and wall time with rules the shared `AGENTS.md` does not have, while Hexframe and YarReader still carry it byte for byte. On 2026-10-28 the owner ruled that all of them become portfolio defaults:
  - `AGENTS.md` is the only required reading, with `grep`/`sed` lookups into the plan and the specification in place of whole-file reads.
  - Session-cost rules: ranged reads, long output to a log, one blocking CI wait, a split at "PR open", handoffs of 25 lines or fewer, and the 200k reminder and 300k block.
  - CI is the only test runner. Agents run typecheck, build and non-test checks locally and dispatch the full suite on the exact head.
  - Task PRs squash into an open `release/rNNN` branch after a fast `gate`; on the owner's "release", the release PR rebase-merges into `main` after full exact-head `verify`.
  - Plan edits are free: a `[PLAN]` PR changes only the plan, takes no ID, and IDs need not be contiguous above a recorded highest-used ID.
  - An independent review on a cheaper model, briefed with only the task block, the diff and the named specification sections. A re-review checks only the blocking findings against the repair.
  - GitHub's merged PRs, checks and Releases are the only delivery record.
- Scope: rewrite `AGENTS.md`, `CONTRIBUTING.md`, the empty `implementation_plan.md` template and `docs/CHANGE-MANAGEMENT.md` around those rules, keeping baseline's ID, title, type and commit-field vocabulary. Update `scripts/check-portfolio-contract.mjs` (pins, queue rules for `[PLAN]` changes and the highest-used ID) and its tests.
- Non-goals: no workflow, ruleset, release or deployment change (BASE-043). No change in a consumer repository; each one adopts the contract on its next sync.
- Acceptance: the new contract states every rule above once. The portfolio check accepts a `[PLAN]` queue edit and a non-contiguous ID above the recorded highest one, and rejects a recycled or lower ID. `npm run check` passes.
- Validation: Pinned `npm ci`, focused portfolio-contract and change-contract tests, `npm run check`, `npm run audit:dependencies`, `check:patch`, `git diff --check` and exact-head CI.
- Authorities: `AGENTS.md`, `CONTRIBUTING.md`, `implementation_plan.md`, `docs/CHANGE-MANAGEMENT.md`, `scripts/check-portfolio-contract.mjs`, and the current `AGENTS.md` of MapLab, RenderLab and RigLab.

### BASE-043 — [OPS] Deliver baseline itself through release branches with CI-only tests

- Dependency: BASE-042.
- Why: the BASE-042 contract makes release branches and CI-only tests the default, and baseline should follow its own contract.
- Scope: a fast `gate` check on task PRs into `release/*` and the full suite as `verify` on the release PR into `main`, with a `config/release.json` naming the open release branch. Rulesets for `release/*` and `main` in `config/github-repository-settings.json` follow, and `scripts/check-change.mjs` accepts task PRs into the open release branch. The tag cut and Release dispatch move to after the release PR's rebase merge. `Wizard-Gang/baseline` joins `agent/hooks/no-tests.json` once `verify` runs every test.
- Non-goals: no change to `deploy-worker.yml`'s caller contract, `platform/`, Cloudflare, secrets or any consumer.
- Acceptance: a task PR into the open release branch merges on green `gate` alone. A release PR merges by rebase only after green exact-head `verify`. A tag is cut only from `main` after a release. Live rulesets read back equal to the committed settings. `npm run check` passes.
- Validation: Pinned `npm ci`, focused change-contract, release-contract, repository-contract and github-settings tests, `npm run check`, `npm run audit:dependencies`, `check:patch`, `git diff --check`, exact-head CI, and `npm run verify:github-settings` after the owner applies the settings.
- Authorities: `.github/workflows/`, `config/github-repository-settings.json`, `scripts/check-change.mjs`, `scripts/release-contract.mjs`, `docs/RELEASE-MANAGEMENT.md`, and the labs' `config/release.json` and gate workflows.
