#!/usr/bin/env node
// PreToolUse guard: refuses a Write/Edit (or a Codex apply_patch) that would push the owner rulebook past its word cap.
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
const readText = (path) => {
  try {
    return readFileSync(real(path), 'utf8');
  } catch {
    return '';
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

// Codex apply_patch carries the patch text in `command`. Word counts add over whole lines, so the
// rulebook's count after the patch is its count now, minus the removed lines, plus the added lines.
export function wordsAfterPatch(patch, cwd, read = readText) {
  let total = null;
  let inRulebook = false;
  for (const line of patch.split('\n')) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      const path = resolve(cwd, header[2].trim());
      inRulebook = isRulebook(path);
      if (inRulebook) total = header[1] === 'Update' ? words(read(path)) : 0;
    } else if (inRulebook && /^[+-]/.test(line)) {
      total += (line[0] === '+' ? 1 : -1) * words(line.slice(1));
    }
  }
  return total;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const { tool_name: tool, tool_input: input, cwd } = JSON.parse(raw);
  let count;
  if (tool === 'apply_patch') count = wordsAfterPatch(String(input?.command ?? ''), cwd || process.cwd());
  else {
    const next = afterEdit(tool, input, isRulebook(input?.file_path) ? readText(input.file_path) : '');
    count = next === null ? null : words(next);
  }
  if (count === null || count <= CAP) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Rulebook cap: this edit makes the owner rulebook (agent/RULEBOOK.md, linked as ~/.claude/CLAUDE.md) ${count} words (cap ${CAP}). Remove or shorten an older rule in the same edit.`,
    },
  }));
}

// realpath: the linked ~/.agent-hooks copy is a symlink, and import.meta.url is the checkout's real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => process.exit(0));
}
