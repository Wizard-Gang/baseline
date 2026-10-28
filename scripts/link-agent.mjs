#!/usr/bin/env node
// Owner-run: links this Mac's agent tooling to the tracked files in agent/.
// Prints the plan by default; --apply links, backing up each replaced file, then re-reads every link.
// An existing entry is replaced only when it reads as the tracked bytes or a recorded pre-move copy;
// anything else stops the run before any change. It never touches ~/.claude/settings.json,
// ~/.codex/hooks.json, ~/.agent-hooks/state/ or ~/.agent-hooks/context-budget.allow.
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = join(ROOT, 'agent');
const NEVER = new Set(['settings.json', 'hooks.json', 'state', 'context-budget.allow']);

// SHA-256 of the untracked copies that BASE-041 changed while moving them (read on 2026-10-28).
export const PREDECESSORS = Object.freeze({
  'hooks/no-tests.mjs': '2762818601b485b2a17658e9d440128cfec8daaa243eca78b35e39994d6d9c19',
  'hooks/context-budget.mjs': 'cea5d39f2c3e88284be218fbc67ebf15dbe07a2d5677700214348c6d3f30dc6a',
  'hooks/rulebook-cap.mjs': '430e88a410866b4f35dc63f557cb118f4e3c2e2cd063c6886f6ee4f2acb466ec',
  'hooks/README.md': '5ab2ac04e61f074b33c3a1f10fa1091c35fa52cf086557874a1286a91cb37314',
  'RULEBOOK-WHY.md': '485e201d8e39bb9219835d5dea23ed52d898bff6b5dd0a9c2e6d1e940d7d090d',
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function linkTargets(home = homedir()) {
  const hooks = readdirSync(join(AGENT, 'hooks')).sort().map((name) => [join(home, '.agent-hooks', name), `hooks/${name}`]);
  return [
    ...hooks,
    [join(home, '.agent-hooks', 'RULEBOOK-WHY.md'), 'RULEBOOK-WHY.md'],
    [join(home, '.claude', 'CLAUDE.md'), 'RULEBOOK.md'],
    [join(home, '.codex', 'AGENTS.md'), 'RULEBOOK.md'],
    [join(home, '.claude', 'agents', 'lab-reviewer.md'), 'claude/agents/lab-reviewer.md'],
  ].map(([path, source]) => {
    if (NEVER.has(path.split('/').pop())) throw new Error(`refusing to link a protected path: ${path}`);
    return { path, source, tracked: join(AGENT, source) };
  });
}

// One of: linked (already done), create, replace (pre-move copy or same bytes), conflict.
export function planTarget(target) {
  let stat;
  try {
    stat = lstatSync(target.path);
  } catch {
    return { ...target, action: 'create' };
  }
  if (stat.isSymbolicLink() && readlinkSync(target.path) === target.tracked) return { ...target, action: 'linked' };
  if (stat.isDirectory()) return { ...target, action: 'conflict', reason: 'is a directory' };
  let bytes;
  try {
    bytes = readFileSync(target.path);
  } catch {
    return { ...target, action: 'conflict', reason: 'is unreadable or a broken link' };
  }
  const known = bytes.equals(readFileSync(target.tracked)) || PREDECESSORS[target.source] === sha256(bytes);
  if (!known) return { ...target, action: 'conflict', reason: 'differs from the tracked file and its pre-move copy' };
  return { ...target, action: 'replace', symlink: stat.isSymbolicLink() ? readlinkSync(target.path) : null };
}

export function applyPlan(plan, home = homedir(), stamp = new Date().toISOString().replace(/[:.]/g, '-')) {
  const backup = join(home, '.agent-hooks', 'pre-link', stamp);
  for (const entry of plan) {
    if (entry.action === 'linked') continue;
    mkdirSync(dirname(entry.path), { recursive: true });
    if (entry.action === 'replace') {
      if (!entry.symlink) {
        const copy = join(backup, relative(home, entry.path));
        mkdirSync(dirname(copy), { recursive: true });
        copyFileSync(entry.path, copy);
      }
      rmSync(entry.path);
    }
    symlinkSync(entry.tracked, entry.path);
  }
  return backup;
}

// Independent re-read: every link points at the tracked file and resolves into this checkout.
export function verifyLinks(targets) {
  return targets.filter((target) => {
    try {
      return readlinkSync(target.path) !== target.tracked || realpathSync(target.path) !== realpathSync(target.tracked);
    } catch {
      return true;
    }
  });
}

function main(args) {
  if (args.some((arg) => arg !== '--apply')) {
    console.error('usage: npm run link:agent [-- --apply]');
    return 2;
  }
  const home = homedir();
  const show = (path) => path.replace(home, '~');
  const plan = linkTargets(home).map(planTarget);
  for (const entry of plan) {
    const detail = entry.reason ?? (entry.symlink ? `was a link to ${show(entry.symlink)}` : entry.action === 'replace' ? 'backed up first' : '');
    console.log(`${entry.action.padEnd(8)} ${show(entry.path)} -> ${relative(ROOT, entry.tracked)}${detail ? ` (${detail})` : ''}`);
  }
  const conflicts = plan.filter((entry) => entry.action === 'conflict');
  if (conflicts.length) {
    console.error(`STOP: ${conflicts.length} conflicting path(s); nothing was changed. Reconcile them with the tracked files first.`);
    return 1;
  }
  if (!args.includes('--apply')) {
    console.log('Plan only. Run npm run link:agent -- --apply to link.');
    return 0;
  }
  const backup = applyPlan(plan, home);
  const broken = verifyLinks(plan);
  for (const entry of broken) console.error(`FAIL ${show(entry.path)} does not resolve to ${relative(ROOT, entry.tracked)}`);
  if (broken.length) return 1;
  console.log(`Linked ${plan.length} paths into ${ROOT}. Replaced files were copied to ${show(backup)}.`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
