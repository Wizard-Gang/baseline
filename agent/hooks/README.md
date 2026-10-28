# Agent hooks

Machine-level hooks shared by Claude Code and Codex. They are tracked in `Wizard-Gang/baseline` under `agent/hooks/` and linked into `~/.agent-hooks/` by `npm run link:agent -- --apply`, so a branch switch in that checkout changes the live hooks.

| File | Role |
| --- | --- |
| `no-tests.mjs` | PreToolUse. Denies agent test runs (vitest, playwright, node --test, `npm test`, any npm script that runs tests, e.g. `npm run check`). Heredoc bodies are ignored. Fails open. |
| `no-tests.json` | Repos it applies to, by git `origin` (`owner/name`): RenderLab, RigLab, MapLab, baseline. |
| `never.mjs` | PreToolUse, every repository. Denies `npm publish`, `gh release create` and every `git push` force form (`--force`, `--force-with-lease`, `-f`, a `+` refspec) through any shell tool. Heredoc bodies and Codex `apply_patch` text are ignored. No bypass. Fails open. |
| `typecheck.mjs` | Stop. When the working tree or the unpushed commits change a `.ts` or `.tsx` file, runs `npm run typecheck`. A pass is silent; a failure blocks the stop once with the first error lines, never again while `stop_hook_active` is set. Never runs tests. Fails open. |
| `typecheck.json` | Repos it applies to, by git `origin`: MapLab, RenderLab, RigLab. |
| `context-budget.mjs` | PreToolUse. Warns at 200k context, blocks work tools at 300k (`context-budget.json`). Writes `~/.agent-hooks/state/` and reads `~/.agent-hooks/context-budget.allow` from the home directory, never from the checkout. |
| `rulebook-cap.mjs` | PreToolUse. Keeps the owner rulebook (`agent/RULEBOOK.md`, linked as `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`) under 700 words through Claude's `Write`/`Edit`/`MultiEdit` and Codex's `apply_patch`. |

`agent/RULEBOOK-WHY.md` (linked as `~/.agent-hooks/RULEBOOK-WHY.md`) says why each rulebook rule exists; read it before changing a rule.

## Wiring (owner-run; `link:agent` never touches these files)

Commands run `/opt/homebrew/bin/node /Users/jacob/.agent-hooks/<hook>.mjs`. Run `npm run link:agent -- --apply` first so `never.mjs`, `typecheck.mjs` and `typecheck.json` exist under `~/.agent-hooks/`.

Claude Code, `~/.claude/settings.json`: keep the three `hooks.PreToolUse` entries (no-tests, context-budget, rulebook-cap), append this fourth `PreToolUse` entry, and add the `Stop` key beside `PreToolUse`:

```json
{
  "matcher": "Bash|Monitor|mcp__terminal__run_in_terminal",
  "hooks": [{ "type": "command", "command": "/opt/homebrew/bin/node /Users/jacob/.agent-hooks/never.mjs", "timeout": 10 }]
}
```

```json
"Stop": [
  { "hooks": [{ "type": "command", "command": "/opt/homebrew/bin/node /Users/jacob/.agent-hooks/typecheck.mjs", "timeout": 180 }] }
]
```

Codex, `~/.codex/hooks.json`: keep the two `hooks.PreToolUse` entries (no-tests, context-budget), append these two, and add the `Stop` key beside `PreToolUse`. Codex hooks name shell commands `Bash` (an `exec_command` payload with `cmd` or `argv` is read too) and file edits `apply_patch`, with the patch in `tool_input.command`; `never.mjs` ignores `apply_patch`, so it needs no matcher.

```json
{ "hooks": [{ "type": "command", "command": "/opt/homebrew/bin/node /Users/jacob/.agent-hooks/never.mjs" }] },
{ "matcher": "apply_patch", "hooks": [{ "type": "command", "command": "/opt/homebrew/bin/node /Users/jacob/.agent-hooks/rulebook-cap.mjs" }] }
```

```json
"Stop": [
  { "hooks": [{ "type": "command", "command": "/opt/homebrew/bin/node /Users/jacob/.agent-hooks/typecheck.mjs", "timeout": 180 }] }
]
```

Codex skips a new or changed hook until it is trusted: open `/hooks` in the Codex CLI and trust the new entries. Codex records trust per command hash, so links that keep the `~/.agent-hooks/` paths keep that trust.

The `lab-reviewer` subagent stays Claude-only. Codex 0.163's agent-role loader reads `.codex/agents/` files as TOML tables that must define `name` and `developer_instructions` (its own error strings, read on 2026-10-28), so it cannot load the Markdown `agent/claude/agents/lab-reviewer.md`, and `link:agent` does not link it for Codex. A Codex reviewer would need its own TOML role.

## Bypass, removal and rollback

Bypass for one command when you want an agent to run tests: `<REPO>_ALLOW_TESTS=1 <command>`, e.g. `RENDERLAB_ALLOW_TESTS=1 npm test` (`RIGLAB_…`, `MAPLAB_…`). `never.mjs` has no bypass; the owner runs those commands.
To turn a repo-scoped hook off: remove the repo from `no-tests.json` or `typecheck.json` (or the hook entries above).

Rollback: delete the links `link:agent` made and copy the files back from `~/.agent-hooks/pre-link/<stamp>/`, which mirrors the home directory.
