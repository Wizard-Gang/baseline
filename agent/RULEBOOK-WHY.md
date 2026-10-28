# Owner rulebook: why each rule exists

Read this before proposing to change a rule in `~/.claude/CLAUDE.md`. It lives here, not in Claude memory, because memory is stored per folder (a session in a repo never loads it) and Codex cannot see Claude memory. Moved here from `~/.claude/projects/-Users-jacob-Documents/memory/rulebook-why.md` on 2026-10-28.

Tracked in `Wizard-Gang/baseline` as `agent/RULEBOOK-WHY.md` since BASE-041, beside `agent/RULEBOOK.md` (the rulebook) and `agent/hooks/`; `npm run link:agent -- --apply` links the home-directory paths to them. Edit the tracked files in the checkout.

`~/.claude/CLAUDE.md` is the owner rulebook, created 2026-10-25. It holds rules only, with a 700-word cap enforced by `~/.agent-hooks/rulebook-cap.mjs` (Claude Write/Edit only; Codex apply_patch is not covered). `~/.codex/AGENTS.md` is a symlink to it, so Codex gets the same rules.

The why for older rules is in these feedback memories, all in `~/.claude/projects/-Users-jacob-Documents/memory/`: `feedback-ts-only-stack.md`, `feedback-merge-every-pr.md`, `feedback-deliver-increments.md`, `feedback-walkthrough-one-list.md`, `feedback-continuation-prompts.md`, `feedback-verify-capability-live.md`.

Rules added 2026-10-25:
- **Truth rules** (read before claiming; search the whole repo before calling anything unused; fix forward; "built" not "fixed"). Jacob pasted a Reddit rulebook write-up and said "i like these ideas". The same write-up supplied the upkeep rule (a rule goes in after a mistake happens twice) and the compact-instructions section.
- **No tests locally**: Jacob chose "block all local test runs" with an env bypass. Tests were 15% of 9 days' cost. See `agent-hooks.md` in the memory folder above, and `README.md` here.
- **Context budget 200k warn / 300k block**: Claude averaged 372k context per call and the "hand off" rule was ignored, with peaks of 965k. Jacob asked to turn it into a hook. See `usage-budget.md` in the memory folder above.
- **Delivery via release branches** (replaced "Every PR ends merged, squash into main"): full CI cost 7–20 min and ran twice per task. Jacob ruled "Fast gate + on-demand", "Rebase, one per task", "Owner calls it" for releases, across all three labs, and OK'd the amendment on 2026-10-25. Details: `~/Documents/handoffs/labs-release-protocol.md`. Older why: `feedback-merge-every-pr.md`.

Rules added 2026-10-28:
- **Split at "PR open"** (from the labs' "Keep sessions cheap"): Jacob ruled every lab rule a portfolio default and the session-cost rules stated once, here (BASE-042). The labs' section duplicated "Session size" except for this split.

**How to apply:** change a rule only with the owner. Keep the rulebook under the cap by replacing rules, and record each new rule's reason here.
