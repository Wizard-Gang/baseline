# Implementation plan

## Open tasks

**Highest ID ever used:** BASE-044.

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
