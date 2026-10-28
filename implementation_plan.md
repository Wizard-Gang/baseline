# Implementation plan

## Open tasks

### BASE-042 — [DOCS] Make the lab delivery process the shared portfolio contract

- Dependency: None. BASE-041 tracks the tooling in `agent/`, so the contract can name it.
- Why: MapLab, RenderLab and RigLab have cut cost and wall time with rules the shared `AGENTS.md` does not have, and each carries its own `AGENTS.md`. Hexframe and YarReader are archived and need no sync. On 2026-10-28 the owner ruled that all of these rules become portfolio defaults, that every `AGENTS.md` derives from baseline's, and that Codex picks up the same rules as Claude Code:
  - `AGENTS.md` is the only required reading, with `grep`/`sed` lookups into the plan and the specification in place of whole-file reads.
  - Session-cost rules (ranged reads, long output to a log, one blocking CI wait, a split at "PR open", handoffs of 25 lines or fewer, and the 200k reminder and 300k block) are stated once, in `agent/RULEBOOK.md`, which both agents load. `AGENTS.md` names it and does not repeat them; the labs' "Keep sessions cheap" section duplicates the rulebook's "Session size".
  - The half of a task after "PR open" (CI wait, merge, post-merge checks) runs on a cheaper model or at lower effort. If a live check shows that Claude Code's `/usage` breaks usage down by subagent and skill, the contract uses it in place of hand-run cost audits.
  - CI is the only test runner. Agents run typecheck, build and non-test checks locally and dispatch the full suite on the exact head.
  - Task PRs squash into an open `release/rNNN` branch after a fast `gate`; on the owner's "release", the release PR rebase-merges into `main` after full exact-head `verify`.
  - Plan edits are free: a `[PLAN]` PR changes only the plan, takes no ID, and IDs need not be contiguous above a recorded highest-used ID.
  - An independent review on a cheaper model, briefed with only the task block, the diff and the named specification sections. A re-review checks only the blocking findings against the repair.
  - GitHub's merged PRs, checks and Releases are the only delivery record.
- Scope: rewrite `AGENTS.md`, `CONTRIBUTING.md`, the empty `implementation_plan.md` template and `docs/CHANGE-MANAGEMENT.md` around those rules, keeping baseline's ID, title, type and commit-field vocabulary. `AGENTS.md` carries nothing repository-specific, so every lab can carry it byte for byte and keep its own invariants in its own documents. Update `scripts/check-portfolio-contract.mjs` (pins, queue rules for `[PLAN]` changes and the highest-used ID) and its tests.
- Non-goals: no workflow, ruleset, release or deployment change (BASE-043). No change in a consumer repository; MapLab, RenderLab and RigLab each adopt the identical `AGENTS.md` in their own next sync task.
- Acceptance: the new contract states every rule above once. The portfolio check accepts a `[PLAN]` queue edit and a non-contiguous ID above the recorded highest one, and rejects a recycled or lower ID. `npm run check` passes.
- Validation: Pinned `npm ci`, focused portfolio-contract and change-contract tests, `npm run check`, `npm run audit:dependencies`, `check:patch`, `git diff --check` and exact-head CI.
- Authorities: `AGENTS.md`, `CONTRIBUTING.md`, `implementation_plan.md`, `docs/CHANGE-MANAGEMENT.md`, `scripts/check-portfolio-contract.mjs`, `agent/RULEBOOK.md`, and the current `AGENTS.md` of MapLab, RenderLab and RigLab.

### BASE-043 — [OPS] Deliver baseline itself through release branches with CI-only tests

- Dependency: BASE-042.
- Why: the BASE-042 contract makes release branches and CI-only tests the default, and baseline should follow its own contract.
- Scope: a fast `gate` check on task PRs into `release/*` and the full suite as `verify` on the release PR into `main`, with a `config/release.json` naming the open release branch. Rulesets for `release/*` and `main` in `config/github-repository-settings.json` follow, and `scripts/check-change.mjs` accepts task PRs into the open release branch. The tag cut and Release dispatch move to after the release PR's rebase merge. `Wizard-Gang/baseline` joins `agent/hooks/no-tests.json` once `verify` runs every test.
- Non-goals: no change to `deploy-worker.yml`'s caller contract, `platform/`, Cloudflare, secrets or any consumer.
- Acceptance: a task PR into the open release branch merges on green `gate` alone. A release PR merges by rebase only after green exact-head `verify`. A tag is cut only from `main` after a release. Live rulesets read back equal to the committed settings. `npm run check` passes.
- Validation: Pinned `npm ci`, focused change-contract, release-contract, repository-contract and github-settings tests, `npm run check`, `npm run audit:dependencies`, `check:patch`, `git diff --check`, exact-head CI, and `npm run verify:github-settings` after the owner applies the settings.
- Authorities: `.github/workflows/`, `config/github-repository-settings.json`, `scripts/check-change.mjs`, `scripts/release-contract.mjs`, `docs/RELEASE-MANAGEMENT.md`, and the labs' `config/release.json` and gate workflows.

### BASE-044 — [OPS] Add the typecheck Stop hook and the never-rules guard for both agents

- Dependency: None. It builds on the tracked hooks and `link:agent` from BASE-041.
- Why: On 2026-10-28 the owner directed two more guards, and Codex must pick them up as well as Claude Code. A Stop hook that typechecks changed TypeScript costs no tokens when it passes and catches type errors before a 7-minute CI round trip, without running tests. The "never" rules that GitHub does not block (`npm publish`, `gh release create`, force pushes) need an agent-side deny; Claude's `permissions.deny` holds them on this Mac, but Codex has no equivalent wired. ML-044 alone owns MapLab's first version release.
- Scope:
  - `agent/hooks/typecheck.mjs` and `agent/hooks/typecheck.json` (repositories by `origin`, the same shape as `no-tests.json`, starting with MapLab, RenderLab and RigLab). On Stop in an enabled repository, when the working tree or the unpushed commits change a `.ts` or `.tsx` file, it runs `npm run typecheck`. A pass is silent. A failure blocks the stop once with the first error lines, and never again while `stop_hook_active` is set. It fails open.
  - `agent/hooks/never.mjs`, a PreToolUse guard for every shell tool of both agents, denies `npm publish`, `gh release create` and every `git push` force form (`--force`, `--force-with-lease`, `-f`, a `+` refspec) in every repository, with heredoc bodies ignored like `no-tests`.
  - `agent/hooks/README.md` gives the owner-run wiring: the `Stop` and `never` entries in `~/.claude/settings.json` and `~/.codex/hooks.json` (re-trusted in Codex `/hooks`), and `rulebook-cap` for Codex `apply_patch`. A live probe settles whether Codex can load the `lab-reviewer` subagent; if it can, `link:agent` links it for Codex too.
- Non-goals: no change to the decisions of `no-tests`, `context-budget` or `rulebook-cap`. The Stop hook never runs tests.
- Acceptance: the typecheck hook passes silently, blocks once on a type error, and skips other repositories, changes without TypeScript and `stop_hook_active`. The guard denies the three commands through `Bash`, `Monitor`, `mcp__terminal__run_in_terminal` and Codex `exec_command`, and allows an ordinary `git push` and `gh release view`. `npm run check` passes.
- Validation: Pinned `npm ci`, focused cases in `tests/agent-tooling.test.mjs`, `npm run check`, `npm run audit:dependencies`, `check:patch`, `git diff --check`, exact-head CI, and the live hooks re-checked on sample payloads after the owner wires them.
- Authorities: `agent/hooks/`, `scripts/link-agent.mjs`, `~/.claude/settings.json`, `~/.codex/hooks.json` and `README.md`.
