#!/usr/bin/env node
// PreToolUse guard: refuses a Write/Edit that would push the owner rulebook past its word cap.
// Fails open: any error or unknown input allows the call.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The tracked rulebook and its linked home path; an edit through either is capped.
const TRACKED = join(dirname(fileURLToPath(import.meta.url)), '..', 'RULEBOOK.md');
const RULEBOOK = join(homedir(), '.claude', 'CLAUDE.md');
const CAP = 700;
const words = (text) => text.split(/\s+/).filter(Boolean).length;
const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

export const isRulebook = (path) => typeof path === 'string' && [real(RULEBOOK), real(TRACKED)].includes(real(path));

// The file's text after the edit, or null when the call does not touch the rulebook.
export function afterEdit(tool, input, current) {
  if (!isRulebook(input?.file_path)) return null;
  if (tool === 'Write') return input.content ?? '';
  const edits = tool === 'MultiEdit' ? input.edits ?? [] : tool === 'Edit' ? [input] : [];
  return edits.reduce((text, edit) => (edit.replace_all
    ? text.split(edit.old_string).join(edit.new_string)
    : text.replace(edit.old_string, () => edit.new_string)), current);
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const { tool_name: tool, tool_input: input } = JSON.parse(raw);
  let current = '';
  try {
    if (isRulebook(input?.file_path)) current = readFileSync(real(input.file_path), 'utf8');
  } catch {}
  const next = afterEdit(tool, input, current);
  if (next === null || words(next) <= CAP) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Rulebook cap: this edit makes the owner rulebook (agent/RULEBOOK.md, linked as ~/.claude/CLAUDE.md) ${words(next)} words (cap ${CAP}). Remove or shorten an older rule in the same edit.`,
    },
  }));
}

// realpath: the linked ~/.agent-hooks copy is a symlink, and import.meta.url is the checkout's real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => process.exit(0));
}
