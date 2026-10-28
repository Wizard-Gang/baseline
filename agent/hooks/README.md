# Agent hooks

Machine-level PreToolUse guards shared by Claude Code and Codex. They are tracked in `Wizard-Gang/baseline` under `agent/hooks/` and linked into `~/.agent-hooks/` by `npm run link:agent -- --apply`, so a branch switch in that checkout changes the live hooks.

| File | Role |
| --- | --- |
| `no-tests.mjs` | Denies agent test runs (vitest, playwright, node --test, `npm test`, any npm script that runs tests, e.g. `npm run check`). Heredoc bodies are ignored. Fails open. |
| `no-tests.json` | Repos it applies to, by git `origin` (`owner/name`): RenderLab, RigLab, MapLab. |
| `context-budget.mjs` | Warns at 200k context, blocks work tools at 300k (`context-budget.json`). Writes `~/.agent-hooks/state/` and reads `~/.agent-hooks/context-budget.allow` from the home directory, never from the checkout. |
| `rulebook-cap.mjs` | Keeps the owner rulebook (`agent/RULEBOOK.md`, linked as `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`) under 700 words through either path. |

`agent/RULEBOOK-WHY.md` (linked as `~/.agent-hooks/RULEBOOK-WHY.md`) says why each rulebook rule exists; read it before changing a rule.

Wired in (untracked; `link:agent` never touches these):
- Claude Code: `~/.claude/settings.json` → `hooks.PreToolUse` (no-tests matcher `Bash|Monitor|mcp__terminal__run_in_terminal`; context-budget matches those plus the other work tools; rulebook-cap matches `Write|Edit|MultiEdit`). Commands run `/opt/homebrew/bin/node /Users/jacob/.agent-hooks/<hook>.mjs`.
- Codex: `~/.codex/hooks.json` (no matcher; the script ignores non-shell tools). Codex trusts each hook by its command, so links that keep the `~/.agent-hooks/` paths keep that trust.

Bypass for one command when you want an agent to run tests: `<REPO>_ALLOW_TESTS=1 <command>`, e.g. `RENDERLAB_ALLOW_TESTS=1 npm test` (`RIGLAB_…`, `MAPLAB_…`).
To turn it off: remove the repo from `no-tests.json` (or the hook entries above).

Rollback: delete the links `link:agent` made and copy the files back from `~/.agent-hooks/pre-link/<stamp>/`, which mirrors the home directory.
