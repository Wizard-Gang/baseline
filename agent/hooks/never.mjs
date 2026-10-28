#!/usr/bin/env node
// PreToolUse guard shared by Claude Code (~/.claude/settings.json) and Codex (~/.codex/hooks.json).
// Denies the owner's "never" commands that GitHub does not block, in every repository:
// npm publish, gh release create and every git push force form. Heredoc bodies are ignored.
// Fails open: any error or unknown input allows the command.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { commandOf, segments, strip, withoutHeredocs } from './no-tests.mjs';

// Options that take the next token as their value, before the subcommand.
const NPM_VALUES = new Set(['--prefix', '-C', '--registry', '--workspace', '-w', '--userconfig', '--cache', '--tag', '--access', '--otp']);
const GH_VALUES = new Set(['-R', '--repo', '--hostname']);
const GIT_VALUES = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const PUSH_VALUES = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

const basename = (token) => token.split('/').pop();

// The positional arguments, skipping options and the values of the options in `values`.
function positionals(args, values) {
  return args.filter((token, index) => !token.startsWith('-') && !values.has(args[index - 1]));
}

function forcePush(args) {
  return args.some((token, index) => {
    if (PUSH_VALUES.has(args[index - 1])) return false;
    if (/^--force(?:-with-lease)?(?:=|$)/.test(token)) return true;
    if (/^-[a-zA-Z]+$/.test(token)) return token.includes('f');
    return token.startsWith('+');
  });
}

// Returns the rule a token list breaks, or null.
export function neverRule(tokens) {
  const [head, ...rest] = strip(tokens).tokens;
  const name = head ? basename(head) : '';
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name) && positionals(rest, NPM_VALUES)[0] === 'publish') return `${name} publish`;
  if (name === 'gh') {
    const [group, verb] = positionals(rest, GH_VALUES);
    if (group === 'release' && (verb === 'create' || verb === 'new')) return 'gh release create';
  }
  if (name === 'git') {
    const start = rest.findIndex((token, index) => !token.startsWith('-') && !GIT_VALUES.has(rest[index - 1]));
    if (rest[start] === 'push' && forcePush(rest.slice(start + 1))) return 'git push --force';
  }
  return null;
}

export function findNever(command) {
  for (const tokens of segments(withoutHeredocs(command))) {
    const rule = neverRule(tokens);
    if (rule) return { rule, segment: tokens.join(' ') };
  }
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw);
  // Codex reports file edits as apply_patch with the patch text in `command`; that text is data.
  if (payload.tool_name === 'apply_patch') return;
  const command = commandOf(payload.tool_input);
  if (!command) return;
  const found = findNever(command);
  if (!found) return;
  const reason = [
    `Blocked by the never hook: \`${found.rule}\` is never run by an agent, in any repository (\`${found.segment}\`).`,
    'Releases come from the release workflow, and history is fixed forward with a new commit, never a force push.',
    'If the owner wants this done, ask the owner to run it.',
  ].join(' ');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}

// realpath: the linked ~/.agent-hooks copy is a symlink, and import.meta.url is the checkout's real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => process.exit(0));
}
