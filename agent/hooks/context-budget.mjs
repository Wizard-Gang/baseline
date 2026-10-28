#!/usr/bin/env node
// PreToolUse guard shared by Claude Code and Codex: keeps sessions short.
// At `warn` context tokens it reminds the agent to wrap up (every `step` tokens of growth).
// At `block` it denies work tools; only commits, PR steps and writing the handoff stay allowed.
// Fails open: any error or unknown input allows the call.
// Machine state (`state/`, `context-budget.allow`) lives in ~/.agent-hooks/ under the home directory, never beside
// this script, which is linked from the baseline checkout.
import { closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { segments, strip, withoutHeredocs } from './no-tests.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = { warn: 200_000, block: 300_000, step: 25_000 };
const HANDOFF = /handoff|continuation|prompt|NEXT[-_]/i;
const MEMORY = /\/\.claude\/projects\/[^/]+\/memory\//;
const STATE_HOME = join(homedir(), '.agent-hooks');
const ALLOW_FILE = join(STATE_HOME, 'context-budget.allow');
const WORK_TOOLS = /^(?:Bash|Monitor|mcp__terminal__run_in_terminal|shell|local_shell|exec_command|unified_exec|apply_patch|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob|WebFetch|WebSearch|Agent|Task|view_image|mcp__Claude_Browser__.*|mcp__claude-in-chrome__.*)$/;

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
};

// Context size of the latest model call, read from the transcript's last ~4 MB.
// Claude: assistant `message.usage`; Codex: `token_count` event `info.last_token_usage`.
export function lastContext(transcriptPath) {
  const size = statSync(transcriptPath).size;
  const length = Math.min(size, 4 * 1024 * 1024);
  const buffer = Buffer.alloc(length);
  const fd = openSync(transcriptPath, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString('utf8').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes('usage')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = entry?.message?.usage;
    if (entry?.type === 'assistant' && usage) {
      const total = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      if (total) return total;
    }
    const codex = entry?.payload?.type === 'token_count' ? entry.payload.info?.last_token_usage : null;
    if (codex?.input_tokens) return codex.input_tokens;
  }
  return 0;
}

const handoffPath = (path) => typeof path === 'string' && (HANDOFF.test(path.split('/').pop()) || path.includes('/handoffs/') || MEMORY.test(path));

// Shell commands still allowed over budget: git, PR steps, blocking CI waits, writing a handoff, the owner override.
function allowedShell(command) {
  const parts = segments(withoutHeredocs(command)).map((tokens) => strip(tokens).tokens);
  return parts.length > 0 && parts.every((tokens) => {
    const [head, sub, verb] = tokens;
    if (!head) return true;
    const redirect = tokens.findIndex((token) => /^>>?$/.test(token));
    const target = redirect >= 0 ? tokens[redirect + 1] : tokens.find((token) => /^>>?\S/.test(token))?.replace(/^>>?/, '');
    if (target && target !== '/dev/null') return handoffPath(target) || target.endsWith('context-budget.allow');
    if (['git', 'cd', 'pwd', 'ls', 'date', 'mkdir', 'true'].includes(head)) return true;
    if (head === 'gh') return sub === 'pr' || (sub === 'run' && verb === 'watch');
    return false;
  });
}

function allowedOverBudget(tool, input = {}) {
  if (!WORK_TOOLS.test(tool)) return true;
  if (['Write', 'Edit', 'MultiEdit'].includes(tool)) return handoffPath(input.file_path);
  if (tool === 'apply_patch') {
    const text = typeof input === 'string' ? input : input.input ?? input.patch ?? '';
    const paths = [...text.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map((match) => match[1].trim());
    return paths.length > 0 && paths.every(handoffPath);
  }
  const command = input.command ?? input.cmd;
  if (command !== undefined) return allowedShell(Array.isArray(command) ? command.at(-1) : command);
  return false;
}

const output = (fields) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } }));

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw);
  const { transcript_path: transcript, session_id: session = 'unknown', tool_name: tool = '', tool_input: input } = payload;
  if (!transcript) return;
  const config = { ...DEFAULTS, ...readJson(join(HERE, 'context-budget.json'), {}) };
  const tokens = lastContext(transcript);
  if (tokens < config.warn) return;
  let allowed = [];
  try {
    allowed = readFileSync(ALLOW_FILE, 'utf8').split('\n').map((line) => line.trim());
  } catch {}
  if (allowed.includes(session)) return;
  const k = (value) => `${Math.round(value / 1000)}k`;
  const wrapUp = `Reach a recoverable point (commit and push, or open the PR), then write a handoff of 25 lines or fewer `
    + `(task, branch/PR, owner rulings, non-derivable facts only) to ~/Documents/handoffs/<repo>-<YYYY-MM-DD>.md or the app's hand-off, and stop.`;
  if (tokens >= config.block) {
    if (allowedOverBudget(tool, input)) return;
    output({
      permissionDecision: 'deny',
      permissionDecisionReason: `Context budget: this session is at ~${k(tokens)} tokens (limit ${k(config.block)}). Start no new work. ${wrapUp} `
        + `Only if the owner explicitly told you in this conversation to keep going: echo ${session} >> ${ALLOW_FILE}`,
    });
    return;
  }
  const stateDir = join(STATE_HOME, 'state');
  const statePath = join(stateDir, `${session.replace(/[^\w.-]/g, '_')}.json`);
  const last = readJson(statePath, { warned: 0 }).warned;
  if (tokens - last < config.step) return;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify({ warned: tokens }));
  // No permissionDecision: "allow" would skip the owner's normal permission prompts.
  output({
    additionalContext: `Context budget: this session is at ~${k(tokens)} tokens; work tools stop at ${k(config.block)}. Finish the current step, not the whole queue. ${wrapUp}`,
  });
}

// realpath: the linked ~/.agent-hooks copy is a symlink, and import.meta.url is the checkout's real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => process.exit(0));
}
