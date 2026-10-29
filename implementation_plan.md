# Implementation plan

## Open tasks

**Highest ID ever used:** BASE-050.

Any PR may fill this queue; a `[PLAN]` PR that changes only this file is the usual way. A new task takes an ID above the highest one recorded here, which rises to it, so a removed ID is never reused. Keep this file tracked; do not delete it when the queue is empty.

### BASE-045 — [OPS] Vendor the shared delivery scripts to consumers under a pinned lock

- Dependency: None.
- Why: The labs carry their own copies of baseline's delivery scripts, and nothing keeps the copies identical. On `origin/main` on 2026-10-29, `check-workflow-shell.mjs`, `workflow-yaml.mjs`, `verify-github-repository-settings.mjs` and `apply-github-repository-settings.mjs` were byte-identical in baseline, RenderLab and RigLab and absent from MapLab, and `check-release.mjs` matched in baseline and RigLab. Every other shared script had already forked (BASE-046).
- Scope:
  - A second grant in `config/phase.json` beside `platform/`: `contract/`, shared delivery tooling only. `scripts/repository-contract.mjs` accepts `contract/` only under that exact grant, as it does `platform/`.
  - The byte-identical scripts move to `contract/`, and baseline's own package scripts run them from there.
  - `vendor:lock` prints a lock for `contract/` as it does for `platform/`, and the conformance `pin` check verifies a consumer's `contract/vendor.lock.json`.
- Non-goals: no change to the forked scripts (BASE-046) or the workflows (BASE-048). No change in a consumer repository; each one adopts on its next sync.
- Acceptance:
  - A consumer checkout with a vendored `contract/` and its lock passes `pin`. An edited, missing or unpinned file fails it.
  - Baseline's checks run from `contract/` with unchanged decisions. `npm run check` passes in CI.
- Validation: Pinned `npm ci`, `npm run check:gate`, `check:repository`, `check:patch`, `npm run audit:dependencies`, `git diff --check` and exact-head CI. Agents run no tests locally.
- Authorities: `config/phase.json`, `scripts/repository-contract.mjs`, `scripts/vendor-lock.mjs`, `platform/conformance/`, `README.md` and `docs/CONTROL-MAP.md`.

### BASE-046 — [OPS] Split the forked delivery scripts into a shared core and per-repository config

- Dependency: BASE-045.
- Why: On `origin/main` on 2026-10-29, `check-change.mjs` existed in four different versions across baseline and the three labs. `change-contract.mjs`, `check-portfolio-contract.mjs`, `repository-contract.mjs` and `github-repository-settings.mjs` existed in three, and `check-patch.mjs`, `release-contract.mjs` and `publish-release.mjs` in two. MapLab had none of the settings-as-code or patch scripts and ran its own `repository-policy.mjs`. Each lab's portfolio check pins its own `AGENTS.md`, although `AGENTS.md` says every repository carries it byte for byte from baseline.
- Scope:
  - Each forked script moves to `contract/` as one implementation. What legitimately differs per repository (ID prefix, last direct-to-main task, required check names, ruleset values, release workflow presence) comes from that repository's committed `config/` files.
  - The vendored portfolio check pins baseline's `AGENTS.md`, `CONTRIBUTING.md` and empty plan template, so a consumer that drifts from them fails its own gate.
  - Baseline runs the shared versions against its own config.
- Non-goals: no change to any rule the scripts enforce in baseline today. No consumer change; each lab adopts by its own task. No workflow change (BASE-048).
- Acceptance:
  - Baseline's checks give the same decisions as before on its own history and config.
  - Each lab's current rules are expressible in its config without code. Where one is not, the task names the difference for an owner ruling instead of forking again.
  - `npm run check` passes in CI.
- Validation: Pinned `npm ci`, `npm run check:gate`, `check:change`, `check:repository`, `check:patch`, `npm run audit:dependencies`, `git diff --check` and exact-head CI.
- Authorities: the scripts named above in baseline and in each lab at its `origin/main`, each lab's `config/`, `AGENTS.md` and `docs/CHANGE-MANAGEMENT.md`.

### BASE-047 — [OPS] Host the dev launcher and let consumers track their launch config

- Dependency: BASE-046, whose shared repository contract carries the `.claude/` rule.
- Why: `scripts/dev.mjs` and `scripts/dev-lifecycle.mjs`, the `npm start` launcher (teardown, install, build, start, readiness, open, a per-worktree port), existed in all three labs as three different copies on 2026-10-29 and not in baseline. RenderLab and RigLab gitignore all of `.claude/`, so their `launch.json` cannot be tracked. The owner's workspace `~/Documents/.claude/launch.json` held the only entries: its `wizardgang` entry pointed to `~/Documents/Git/WizardGang`, which does not exist, and its `riglab` entry put Node 26.10.0 on `PATH` from `/private/tmp` and an old session scratchpad, which macOS clears. Homebrew's Node was 26.7.0 against the 26.10.0 pin.
- Scope:
  - One launcher in `contract/`, vendored, taking the repository name, port variable, default port and build steps from consumer config.
  - The shared repository contract requires a consumer to ignore only `.claude/worktrees/` and `.claude/settings.local.json`, never all of `.claude/`. It accepts a tracked `.claude/launch.json` whose entry runs `npm start` with no absolute or temporary path.
  - `README.md` gives the owner-run steps to install the pinned Node outside `/tmp` and to fix or remove the stale workspace entries.
- Non-goals: no consumer change and no toolchain beyond the pinned Node and npm.
- Acceptance:
  - The launcher replaces a running server on its port, honors the per-worktree port and no-open variables, and stops what it started on Ctrl-C, as the labs' launchers do.
  - A consumer `.gitignore` that ignores all of `.claude/`, or a `launch.json` with an absolute or `/tmp` path, fails the repository contract.
  - `npm run check` passes in CI.
- Validation: Pinned `npm ci`, `npm run check:gate`, `check:repository`, `check:patch`, `npm run audit:dependencies`, `git diff --check` and exact-head CI.
- Authorities: each lab's `scripts/dev.mjs`, `scripts/dev-lifecycle.mjs`, `.gitignore` and README command map at its `origin/main`, `scripts/repository-contract.mjs` and `README.md`.

### BASE-048 — [OPS] Give every repository one CI shape for gate, change-id, verify and security

- Dependency: BASE-046.
- Why: On 2026-10-29 baseline ran `gate`, `change-id`, `verify` and `security` as jobs in one `verify.yml`. RenderLab and RigLab split them into `gate.yml`, `change.yml` and `verify.yml`, identical to each other, and MapLab's `gate.yml` and `change.yml` differed from both. Three shapes carry the same required checks.
- Scope:
  - Choose one shape that keeps the required check names `gate`, `change-id`, `verify` and `security` and the strict current-with-base policy, and make baseline's own workflows match it.
  - Consumers carry the chosen workflow files byte for byte under their lock. Per-repository steps (build, browsers, fixtures) run through package scripts, not workflow edits.
- Non-goals: no change to `deploy-worker.yml`, `release.yml` or `release-cutter.yml`, to required checks or rulesets, or to any consumer.
- Acceptance:
  - A baseline task PR and release PR pass on the new shape with unchanged required check names.
  - `check:workflow-shell` accepts the shared files, and a consumer workflow that differs from its lock fails `pin`.
- Validation: Pinned `npm ci`, `npm run check:gate`, `check:workflow-shell`, `check:patch`, `npm run audit:dependencies`, `git diff --check`, exact-head CI, and `npm run verify:github-settings` read-back.
- Authorities: `.github/workflows/` in baseline and each lab, `config/github-repository-settings.json`, `scripts/check-workflow-shell.mjs` and `docs/RELEASE-MANAGEMENT.md`.

### BASE-049 — [OPS] Move the delivery procedures into Claude Code skills

- Dependency: None.
- Why: Claude Code's documented practice (code.claude.com/docs/en/best-practices, "Put team procedures in skills") keeps step-by-step procedures in skills, which load only when used, and marks a side-effecting one `disable-model-invocation: true` so only a person can start it. Today "only on the owner's release" is a line Claude reads, not something Claude Code enforces.
- Scope:
  - `agent/claude/skills/` holds `needful` (deliver the first open task to "PR open" and write the handoff), `release` (open, wait on, rebase-merge and confirm the release PR, with `disable-model-invocation: true`) and `handoff` (the 25-line handoff in `~/Documents/handoffs/`). Each holds only steps and commands that `AGENTS.md` does not already state.
  - `link:agent` links each skill into `~/.claude/skills/` under the same plan, backup and re-read rules as its other links.
  - A read-only probe first confirms whether the installed Codex loads skills and from where. Codex links are added only if it does.
- Non-goals: `AGENTS.md` keeps every rule both agents need, and the owner can still say "release" in words. No hook or settings change.
- Acceptance:
  - On a temporary home every skill link resolves into the checkout, and a conflicting file stops the run unchanged.
  - The model cannot start `release`. No skill names a file, script or command that does not exist.
  - `npm run check` passes in CI.
- Validation: Pinned `npm ci`, `npm run check:gate`, `check:patch`, `npm run audit:dependencies`, `git diff --check` and exact-head CI covering `tests/agent-tooling.test.mjs`.
- Authorities: `AGENTS.md`, `docs/CHANGE-MANAGEMENT.md`, `docs/RELEASE-MANAGEMENT.md`, `agent/RULEBOOK.md`, `agent/hooks/README.md` and `scripts/link-agent.mjs`.

### BASE-050 — [OPS] Make the lab reviewer read-only by hook and add an auto-compact backstop

- Dependency: None.
- Why: `agent/claude/agents/lab-reviewer.md` has `Bash`, so its read-only rule is only a prompt line: nothing stops it from running `gh pr merge` or `git push`, and it has no turn cap. The context-budget hook blocks work tools at 300k, but a session with the owner's override runs to the default compaction near the top of the 1M window. Claude Code's subagent `hooks` and `maxTurns` fields and its `autoCompactWindow` setting (100000 to 1000000 tokens) cover both.
- Scope:
  - A tracked `agent/hooks/` script, wired as a PreToolUse hook on `Bash` in the reviewer's frontmatter, allows only read commands (`git diff`, `log`, `show` and `rev-parse`; `gh pr diff`, `view` and `checks`; `grep`, `sed`, `awk`, `head`, `tail` and `wc`) and denies everything else, including anything it cannot parse. The reviewer also gets a `maxTurns` cap.
  - The owner-run `~/.claude/settings.json` block in `agent/hooks/README.md` adds `"autoCompactWindow": 400000` as a backstop above the 300k block.
- Non-goals: no change to the reviewer's prompt, model or report shape, the context-budget thresholds or any other hook.
- Acceptance:
  - On sample payloads the reviewer hook allows each listed read command and denies `git push`, `gh pr merge`, `gh pr comment`, `gh pr review`, `npm` and any write redirection.
  - The `link:agent` plan includes the new hook file. `npm run check` passes in CI.
- Validation: Pinned `npm ci`, `npm run check:gate`, `check:patch`, `npm run audit:dependencies`, `git diff --check` and exact-head CI covering `tests/agent-tooling.test.mjs`.
- Authorities: `agent/claude/agents/lab-reviewer.md`, `agent/hooks/`, `agent/hooks/README.md`, `scripts/link-agent.mjs`, and Claude Code's sub-agents and settings reference.
