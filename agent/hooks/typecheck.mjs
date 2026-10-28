#!/usr/bin/env node
// Stop hook shared by Claude Code (~/.claude/settings.json) and Codex (~/.codex/hooks.json).
// In the repos listed in typecheck.json, when the working tree or the unpushed commits change a
// .ts or .tsx file, it runs `npm run typecheck`. A pass is silent; a failure blocks the stop once
// with the first error lines, and never again while stop_hook_active is set. It never runs tests.
// Fails open: any error, timeout or missing typecheck script lets the agent stop.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoOf } from './no-tests.mjs';

const TYPESCRIPT = /\.tsx?$/;
const LINES = 20;
const TIMEOUT = 170_000;

const git = (top, args) => execFileSync('git', ['-C', top, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });

// Paths changed in the working tree (untracked included) or in commits no remote has.
export function changedFiles(top) {
  const status = git(top, ['status', '--porcelain', '-z', '--untracked-files=all']).split('\0').filter(Boolean);
  const unpushed = git(top, ['log', 'HEAD', '--not', '--remotes', '--name-only', '--format=']).split('\n').filter(Boolean);
  return [...status.map((entry) => entry.replace(/^.. /, '')), ...unpushed];
}

function enabledRepos() {
  try {
    const config = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'typecheck.json'), 'utf8'));
    return Array.isArray(config.repos) ? config.repos : [];
  } catch {
    return [];
  }
}

// Returns the block reason, or null to let the agent stop.
export function check(payload, enabled = enabledRepos()) {
  if (payload.stop_hook_active) return null;
  const repo = repoOf(payload.cwd || process.cwd());
  if (!repo || !enabled.includes(repo.slug)) return null;
  const scripts = JSON.parse(readFileSync(join(repo.top, 'package.json'), 'utf8')).scripts ?? {};
  if (typeof scripts.typecheck !== 'string' || !changedFiles(repo.top).some((path) => TYPESCRIPT.test(path))) return null;
  const run = spawnSync('npm', ['run', '--silent', 'typecheck'], {
    cwd: repo.top,
    encoding: 'utf8',
    timeout: TIMEOUT,
    // GUI-launched agents may lack node on PATH; prefer the node running this hook.
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
  });
  // Spawn errors, timeouts and a missing tool (127) are not type errors.
  if (run.error || run.signal || run.status === 0 || run.status === 127) return null;
  const lines = `${run.stdout}\n${run.stderr}`.split('\n').filter((line) => line.trim()).slice(0, LINES);
  return [
    `Typecheck failed in ${repo.slug} (\`npm run typecheck\`, exit ${run.status}). Fix these type errors before you stop;`,
    'this hook blocks once and then lets you stop. It never runs tests.',
    '',
    ...lines,
  ].join('\n');
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const reason = check(JSON.parse(raw));
  if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

// realpath: the linked ~/.agent-hooks copy is a symlink, and import.meta.url is the checkout's real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => process.exit(0));
}
