#!/usr/bin/env node
// PreToolUse guard shared by Claude Code (~/.claude/settings.json) and Codex (~/.codex/hooks.json).
// Blocks agent test runs in the repos listed in no-tests.json; CI is the only test runner there.
// Fails open: any error or unknown input allows the command.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNERS = new Set(['vitest', 'playwright', 'jest', 'mocha', 'ava', 'tap', 'uvu', 'c8']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const TEST_VERBS = new Set(['test', 't', 'tst', 'cit', 'it', 'install-test', 'install-ci-test']);
const WRAPPERS = new Set(['exec', 'time', 'command', 'nohup', 'env', 'sudo', 'caffeinate']);
const VALUE_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd', '-w', '--workspace', '--filter', '-F']);

const expand = (path, base) => {
  const home = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
  return isAbsolute(home) ? home : resolve(base, home);
};
const unquote = (token) => token.replace(/^(['"])(.*)\1$/, '$2');
const basename = (token) => unquote(token).split('/').pop();

// Drops heredoc bodies (`<<EOF ... EOF`); they are data, not commands.
export function withoutHeredocs(command) {
  const lines = command.split('\n');
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    out.push(lines[index]);
    const delimiters = [...lines[index].matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)].map((match) => match[2]);
    for (const delimiter of delimiters) {
      while (index + 1 < lines.length && lines[index + 1].trim() !== delimiter) index += 1;
      index += 1;
    }
  }
  return out.join('\n');
}

// Splits a shell command into token lists at ; & | ( ) ` and newlines outside quotes.
// Quotes are removed from tokens; `sh -c '...'` bodies are split again.
export function segments(command) {
  const out = [];
  let tokens = [];
  let token = null;
  let quote = null;
  const endToken = () => {
    if (token !== null) tokens.push(token);
    token = null;
  };
  const endSegment = () => {
    endToken();
    const shell = tokens.findIndex((value, index) => /^(?:\S*\/)?(?:ba|z|da)?sh$/.test(value) && /^-\w*c$/.test(tokens[index + 1] ?? ''));
    if (shell >= 0 && tokens[shell + 2]) out.push(...segments(tokens[shell + 2]));
    else if (tokens.length) out.push(tokens);
    tokens = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && index + 1 < command.length) token += command[++index];
      else token += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      token ??= '';
    } else if (char === '\\' && index + 1 < command.length) {
      token = (token ?? '') + command[++index];
    } else if (/\s/.test(char) && char !== '\n') {
      endToken();
    } else if (';&|()`\n'.includes(char)) {
      // `2>&1` and `&>` are redirects, not separators.
      if (char === '&' && (command[index - 1] === '>' || command[index + 1] === '>')) token = (token ?? '') + char;
      else endSegment();
    } else {
      token = (token ?? '') + char;
    }
  }
  endSegment();
  return out;
}

// Removes leading VAR=value assignments and wrappers; returns the env it saw and the rest.
export function strip(tokens) {
  const env = {};
  let index = 0;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
    if (assignment) env[assignment[1]] = unquote(assignment[2]);
    else if (token === 'timeout' || token === 'gtimeout') index += 1;
    else if (!WRAPPERS.has(token) && !token.startsWith('-')) break;
  }
  return { env, tokens: tokens.slice(index) };
}

const withoutFlags = (tokens) => tokens.filter((token, index) => !token.startsWith('-') && !VALUE_FLAGS.has(tokens[index - 1]));

function readScripts(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {};
  } catch {
    return {};
  }
}

// A script is a test script if its name starts with "test" or its body runs a test (transitively).
function isTestScript(name, scripts, seen = new Set()) {
  if (/^test(?::|$)/.test(name)) return true;
  if (seen.has(name) || typeof scripts[name] !== 'string') return false;
  seen.add(name);
  return segments(scripts[name]).some((tokens) => runsTests(strip(tokens).tokens, scripts, seen));
}

function runsTests(tokens, scripts, seen = new Set()) {
  if (!tokens.length) return false;
  const [head, ...rest] = tokens;
  const name = basename(head);
  const args = withoutFlags(rest).map(unquote);
  if (RUNNERS.has(name.replace(/\.(?:m?js|cjs)$/, ''))) return name !== 'playwright' || args[0] === 'test';
  if (name === 'node' || name === 'tsx' || name === 'deno') {
    if (rest.includes('--test') || (name === 'deno' && args[0] === 'test')) return true;
    return args.length > 0 && runsTests(args, scripts, seen);
  }
  if (name === 'npx' || name === 'bunx' || name === 'pnpx') return runsTests(args, scripts, seen);
  if (PACKAGE_MANAGERS.has(name)) {
    const [verb, target] = args;
    if (verb === 'exec' || verb === 'dlx' || verb === 'x') return runsTests(args.slice(1), scripts, seen);
    if (TEST_VERBS.has(verb)) return true;
    if (verb === 'run' || verb === 'run-script' || verb === 'rum' || verb === 'urn') return Boolean(target) && isTestScript(target, scripts, seen);
    return name !== 'npm' && Boolean(verb) && scripts[verb] !== undefined && isTestScript(verb, scripts, seen);
  }
  return false;
}

export function repoOf(dir) {
  try {
    const url = execFileSync('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
    return match ? { slug: match[1], top } : null;
  } catch {
    return null;
  }
}

export function commandOf(input) {
  const value = input?.command ?? input?.cmd ?? input?.argv;
  if (Array.isArray(value)) {
    const shell = value.findIndex((token) => /^-\w*c$/.test(token));
    return shell >= 0 && value[shell + 1] ? value.slice(shell + 1).join(' ') : value.join(' ');
  }
  return typeof value === 'string' ? value : '';
}

// Returns the first blocked {repo, segment}, following `cd` and --prefix/-C between segments.
export function findBlocked(command, cwd, enabled, env = process.env) {
  let dir = cwd;
  let exported = {};
  for (const raw of segments(withoutHeredocs(command))) {
    const { env: inline, tokens } = strip(raw);
    if (tokens[0] === 'cd' && tokens[1]) {
      dir = expand(unquote(tokens[1]), dir);
      continue;
    }
    if (tokens[0] === 'export') {
      for (const token of tokens.slice(1)) Object.assign(exported, strip([token]).env);
      continue;
    }
    const flag = tokens.findIndex((token) => VALUE_FLAGS.has(token) && ['--prefix', '-C', '--dir', '--cwd'].includes(token));
    const target = flag >= 0 && tokens[flag + 1] ? expand(unquote(tokens[flag + 1]), dir) : dir;
    const repo = repoOf(target);
    if (!repo || !enabled.includes(repo.slug)) continue;
    const allow = `${repo.slug.split('/')[1].toUpperCase().replace(/[^A-Z0-9]/g, '_')}_ALLOW_TESTS`;
    if ([env[allow], exported[allow], inline[allow]].includes('1')) continue;
    const scripts = readScripts(flag >= 0 ? target : findPackageDir(target, repo.top));
    if (runsTests(tokens, scripts)) return { repo: repo.slug, allow, segment: tokens.join(' ') };
  }
  return null;
}

function findPackageDir(dir, top) {
  for (let current = dir; current.startsWith(top); current = dirname(current)) {
    try {
      readFileSync(join(current, 'package.json'));
      return current;
    } catch {
      if (current === top) break;
    }
  }
  return top;
}

function enabledRepos() {
  try {
    const config = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'no-tests.json'), 'utf8'));
    return Array.isArray(config.repos) ? config.repos : [];
  } catch {
    return [];
  }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw);
  const command = commandOf(payload.tool_input);
  if (!command) return;
  const blocked = findBlocked(command, payload.cwd || process.cwd(), enabledRepos());
  if (!blocked) return;
  const reason = [
    `Blocked by the no-tests hook: agents do not run tests in ${blocked.repo} (\`${blocked.segment}\`).`,
    'CI runs them on every PR. Push the branch and read the exact-head required checks instead.',
    'Typecheck, build, lint and the non-test check scripts are still allowed.',
    `Only if the owner explicitly told you in this conversation to run tests, rerun with ${blocked.allow}=1 prefixed.`,
  ].join(' ');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}

// realpath: the linked ~/.agent-hooks copy is a symlink, and import.meta.url is the checkout's real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => process.exit(0));
}
