# Owner rulebook (all projects, Claude Code and Codex)

Rules only, capped at 700 words; `~/.agent-hooks/rulebook-cap.mjs` refuses edits past the cap, so a new rule pushes an old one out. A rule goes in after the same mistake happens twice. Each rule's dated reason is in `~/.agent-hooks/RULEBOOK-WHY.md`; read it before proposing to change a rule. Repo `AGENTS.md` files govern their own repo; where one conflicts with a hook below, the hook wins.

## About the owner

- Jacob (GitHub `SouthernGentlemen`, org `Wizard-Gang`). Repos live in `~/Documents/GitHub/`. macOS, Safari.
- Apps are React + TypeScript (Node/Vite) only. Never add Rust, Tauri, Cargo or other native toolchains unless he asks; treat "owner installs toolchain X" as a reason to ask first.
- Give run commands with the `cd` included, one command per block.

## Truth

- Never state anything about the code you have not just read. No answering from memory, a handoff or a doc.
- Before calling anything unused or dead, search the whole repo. One narrow search does not count.
- Treat an inherited blocker as a hypothesis: run the cheapest read-only probe that proves or disproves it before repeating it.
- Say "built, verified by X" or "built, not verified", never "fixed" for something the owner has to see.
- Fix forward. Never revert, reset or roll back published work unless the owner says so.

## Tests and CI (hook: `no-tests`)

- In RenderLab, RigLab and MapLab, agents do not run tests: no vitest, playwright, `node --test`, `npm test` or `npm run check`. CI's required checks are the test runner. Locally run typecheck, build and the non-test `check:*` scripts, then push and read the exact-head checks.
- Wait on CI with one blocking `gh run watch --exit-status` or `gh pr checks --watch`, never sleep loops or repeated polls.
- The bypass `<REPO>_ALLOW_TESTS=1` is for when the owner explicitly asks in this conversation.

## Delivery

- Task PRs squash into the open `release/*` branch after its fast gate; on the owner's "release", the release PR rebase-merges into main after full exact-head CI. Branches auto-delete. Never hand back an open PR waiting on CI.
- Land small committed pieces each turn. Keep each file write under about 250 lines; never stall on surveys or one giant write.
- When the owner runs provider steps himself, give one complete ordered list from the top, then reply tersely as he reports each step. Never re-send the whole set.

## Session size (hook: `context-budget`)

- Every tool call re-sends the whole session. Read by range (`grep -n`, `sed -n`), never re-read what you have, and send long output to a log and print only the tail.
- At ~200k context, finish the current step, not the whole queue. At 300k, work tools are blocked: reach a recoverable point (commit, push or PR open), then hand off.
- Split a task at "PR open": the CI wait, review, merge and post-merge checks start in a fresh session from a handoff.
- A handoff is 25 lines or fewer: the task, branch/PR, owner rulings and the facts the next session cannot re-read. Write it to `~/Documents/handoffs/<repo>-<YYYY-MM-DD>.md` or use the app's hand-off. Split risky releases before handing off.
- The override (`echo <session_id> >> ~/.agent-hooks/context-budget.allow`) is only for when the owner explicitly says to keep going.

## Compact instructions

When summarizing a long session, keep word for word: the owner's rulings and quotes, file paths, branch/PR numbers and SHAs, and anything not yet committed, pushed or saved.
