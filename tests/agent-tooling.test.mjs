import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { linkTargets, verifyLinks } from '../scripts/link-agent.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hooks = join(root, 'agent', 'hooks');
const SESSION = 'session-1';

const tempDir = (label) => realpathSync(mkdtempSync(join(tmpdir(), `agent-${label}-`)));
const words = (count) => Array.from({ length: count }, () => 'word').join(' ');

function hook(script, payload, home) {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null;
}

const decision = (output) => output?.permissionDecision ?? 'none';

function repo(slug) {
  const dir = tempDir('repo');
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/${slug}.git`]);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', check: 'tsc && npm test', typecheck: 'tsc --noEmit' } }));
  return dir;
}

function transcript(lines) {
  const path = join(tempDir('transcript'), 'session.jsonl');
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return path;
}

const claudeAt = (tokens) => transcript([{ type: 'assistant', message: { usage: { input_tokens: tokens } } }]);

test('no-tests denies agent test runs in enabled repositories through every shell tool', () => {
  const home = tempDir('home');
  const maplab = repo('Wizard-Gang/MapLab');
  const run = (command, tool = 'Bash', cwd = maplab) => decision(hook(join(hooks, 'no-tests.mjs'), { tool_name: tool, cwd, tool_input: { command } }, home));
  for (const tool of ['Bash', 'Monitor', 'mcp__terminal__run_in_terminal']) assert.equal(run('npm test', tool), 'deny', tool);
  assert.equal(run('npx vitest run'), 'deny');
  assert.equal(run('npm run check'), 'deny', 'a script that runs tests is a test run');
  assert.equal(run(`cd ${maplab} && node --test tests/a.test.mjs`, 'Bash', home), 'deny');
  assert.equal(run('npm run typecheck'), 'none');
  assert.equal(run('gh run watch 1 --exit-status'), 'none');
  assert.equal(run("cat > notes.md <<'EOF'\nnpm test\nEOF"), 'none', 'heredoc bodies are ignored');
  assert.equal(run('MAPLAB_ALLOW_TESTS=1 npm test'), 'none', 'the owner bypass');
  assert.equal(run('npm test', 'Bash', repo('Wizard-Gang/baseline')), 'none', 'repositories outside no-tests.json');
  const reason = hook(join(hooks, 'no-tests.mjs'), { tool_name: 'Bash', cwd: maplab, tool_input: { command: 'npm test' } }, home).permissionDecisionReason;
  assert.match(reason, /MAPLAB_ALLOW_TESTS=1/);
});

test('context-budget reminds at 200k, blocks work tools at 300k and keeps state in the home directory', () => {
  const home = tempDir('home');
  const budget = (path, tool, input) => hook(join(hooks, 'context-budget.mjs'), { transcript_path: path, session_id: SESSION, tool_name: tool, tool_input: input }, home);
  assert.equal(budget(claudeAt(150_000), 'Read', { file_path: '/x' }), null);
  assert.match(budget(claudeAt(210_000), 'Read', { file_path: '/x' }).additionalContext, /~210k tokens; work tools stop at 300k/);
  assert.ok(existsSync(join(home, '.agent-hooks', 'state', `${SESSION}.json`)));
  assert.ok(!existsSync(join(hooks, 'state')), 'no state lands in the checkout');
  assert.equal(budget(claudeAt(220_000), 'Read', { file_path: '/x' }), null, 'one reminder per 25k of growth');
  assert.ok(budget(claudeAt(236_000), 'Read', { file_path: '/x' }).additionalContext);

  const over = claudeAt(310_000);
  const bash = (command) => decision(budget(over, 'Bash', { command }));
  assert.equal(decision(budget(over, 'Read', { file_path: '/x' })), 'deny');
  assert.equal(bash('npm run build'), 'deny');
  for (const allowed of ['git commit -m x && git push', 'gh pr create --fill', 'gh run watch 1 --exit-status', 'cat > ~/Documents/handoffs/a.md <<EOF\nx\nEOF']) {
    assert.equal(bash(allowed), 'none', allowed);
  }
  assert.equal(decision(budget(over, 'Write', { file_path: '/h/Documents/handoffs/baseline.md' })), 'none');
  assert.equal(decision(budget(over, 'Write', { file_path: '/repo/src/a.ts' })), 'deny');
  assert.equal(decision(budget(over, 'TodoWrite', {})), 'none', 'non-work tools stay allowed');
  const codex = transcript([{ payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 310_000 } } } }]);
  assert.equal(decision(budget(codex, 'exec_command', { cmd: 'npm run build' })), 'deny');
  assert.match(budget(over, 'Read', { file_path: '/x' }).permissionDecisionReason, new RegExp(`echo ${SESSION} >> ${home}/\\.agent-hooks/context-budget\\.allow`));

  writeFileSync(join(home, '.agent-hooks', 'context-budget.allow'), `${SESSION}\n`);
  assert.equal(budget(over, 'Read', { file_path: '/x' }), null, 'the owner override');
  assert.ok(!existsSync(join(hooks, 'context-budget.allow')));
});

test('rulebook-cap holds 700 words through the home path and the tracked file', () => {
  const home = tempDir('home');
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), words(600));
  const cap = (tool, input) => decision(hook(join(hooks, 'rulebook-cap.mjs'), { tool_name: tool, tool_input: input }, home));
  const homePath = join(home, '.claude', 'CLAUDE.md');
  const tracked = join(root, 'agent', 'RULEBOOK.md');
  assert.equal(cap('Write', { file_path: homePath, content: words(700) }), 'none');
  assert.equal(cap('Write', { file_path: homePath, content: words(701) }), 'deny');
  assert.equal(cap('Edit', { file_path: homePath, old_string: 'word', new_string: words(102) }), 'deny');
  assert.equal(cap('Write', { file_path: tracked, content: words(701) }), 'deny');
  const line = readFileSync(tracked, 'utf8').split('\n').find((text) => text.startsWith('- '));
  assert.equal(cap('Edit', { file_path: tracked, old_string: line, new_string: `${line} ${words(700)}` }), 'deny');
  assert.equal(cap('Write', { file_path: join(home, 'other.md'), content: words(900) }), 'none');
  assert.ok(readFileSync(tracked, 'utf8').split(/\s+/).filter(Boolean).length <= 700, 'the tracked rulebook is within the cap');
});

function seededHome() {
  const home = tempDir('home');
  for (const dir of ['.agent-hooks/state', '.claude/agents', '.codex']) mkdirSync(join(home, dir), { recursive: true });
  copyFileSync(join(hooks, 'no-tests.mjs'), join(home, '.agent-hooks', 'no-tests.mjs'));
  copyFileSync(join(root, 'agent', 'RULEBOOK.md'), join(home, '.claude', 'CLAUDE.md'));
  symlinkSync(join(home, '.claude', 'CLAUDE.md'), join(home, '.codex', 'AGENTS.md'));
  const untouched = { '.claude/settings.json': '{"hooks":{}}', '.codex/hooks.json': '{"hooks":{}}', '.agent-hooks/state/old.json': '{"warned":1}', '.agent-hooks/context-budget.allow': 'old\n' };
  for (const [path, text] of Object.entries(untouched)) writeFileSync(join(home, path), text);
  return { home, untouched };
}

const link = (home, ...args) => spawnSync(process.execPath, [join(root, 'scripts', 'link-agent.mjs'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });

test('link:agent plans by default, then links every path into the checkout and nothing else', () => {
  const { home, untouched } = seededHome();
  const plan = link(home);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /^replace +~\/\.claude\/CLAUDE\.md -> agent\/RULEBOOK\.md \(backed up first\)$/m);
  assert.match(plan.stdout, /^replace +~\/\.codex\/AGENTS\.md -> agent\/RULEBOOK\.md \(was a link to ~\/\.claude\/CLAUDE\.md\)$/m);
  assert.match(plan.stdout, /^create +~\/\.claude\/agents\/lab-reviewer\.md/m);
  assert.ok(!lstatSync(join(home, '.claude', 'CLAUDE.md')).isSymbolicLink(), 'the plan changes nothing');

  const applied = link(home, '--apply');
  assert.equal(applied.status, 0, applied.stderr);
  const targets = linkTargets(home);
  assert.equal(targets.length, readdirSync(hooks).length + 4);
  assert.deepEqual(verifyLinks(targets), []);
  for (const target of targets) assert.ok(realpathSync(target.path).startsWith(`${realpathSync(root)}/agent/`), target.path);
  for (const [path, text] of Object.entries(untouched)) assert.equal(readFileSync(join(home, path), 'utf8'), text, path);
  const [stamp] = readdirSync(join(home, '.agent-hooks', 'pre-link'));
  assert.equal(readFileSync(join(home, '.agent-hooks', 'pre-link', stamp, '.claude', 'CLAUDE.md'), 'utf8'), readFileSync(join(root, 'agent', 'RULEBOOK.md'), 'utf8'));

  const maplab = repo('Wizard-Gang/MapLab');
  assert.equal(decision(hook(join(home, '.agent-hooks', 'no-tests.mjs'), { tool_name: 'Bash', cwd: maplab, tool_input: { command: 'npm test' } }, home)), 'deny', 'a linked hook still runs');
  const reminded = hook(join(home, '.agent-hooks', 'context-budget.mjs'), { transcript_path: claudeAt(210_000), session_id: 'linked', tool_name: 'Read', tool_input: {} }, home);
  assert.ok(reminded.additionalContext);
  assert.ok(existsSync(join(home, '.agent-hooks', 'state', 'linked.json')));
  assert.ok(!existsSync(join(hooks, 'state')), 'no state lands in the checkout through a link');

  const again = link(home, '--apply');
  assert.equal(again.status, 0, again.stderr);
  assert.ok(again.stdout.split('\n').filter(Boolean).slice(0, -1).every((line) => line.startsWith('linked ')), again.stdout);
});

test('link:agent stops on a conflicting local file and changes nothing', () => {
  const { home } = seededHome();
  writeFileSync(join(home, '.claude', 'agents', 'lab-reviewer.md'), 'a local edit\n');
  const result = link(home, '--apply');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^conflict ~\/\.claude\/agents\/lab-reviewer\.md .*differs from the tracked file/m);
  assert.match(result.stderr, /STOP: 1 conflicting path\(s\); nothing was changed/);
  assert.ok(!lstatSync(join(home, '.claude', 'CLAUDE.md')).isSymbolicLink());
  assert.ok(!existsSync(join(home, '.agent-hooks', 'context-budget.mjs')));
  assert.ok(!existsSync(join(home, '.agent-hooks', 'pre-link')));
  assert.equal(link(home, '--force').status, 2, 'unknown arguments are usage errors');
});
