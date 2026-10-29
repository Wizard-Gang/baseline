import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  assert.equal(run('npm test', 'Bash', repo('Wizard-Gang/WizardGang')), 'none', 'repositories outside no-tests.json');
  assert.equal(run('npm run check', 'Bash', repo('Wizard-Gang/baseline')), 'deny', 'baseline follows its own CI-only contract');
  const reason = hook(join(hooks, 'no-tests.mjs'), { tool_name: 'Bash', cwd: maplab, tool_input: { command: 'npm test' } }, home).permissionDecisionReason;
  assert.match(reason, /MAPLAB_ALLOW_TESTS=1/);
});

test('never denies publish, release creation and force pushes in every repository through every shell tool', () => {
  const home = tempDir('home');
  const never = (command, tool = 'Bash', input = { command }) => decision(hook(join(hooks, 'never.mjs'), { tool_name: tool, cwd: home, tool_input: input }, home));
  for (const tool of ['Bash', 'Monitor', 'mcp__terminal__run_in_terminal']) {
    for (const command of ['npm publish', 'gh release create v1.0.0', 'git push --force']) assert.equal(never(command, tool), 'deny', `${tool}: ${command}`);
  }
  assert.equal(never('', 'exec_command', { cmd: 'npm publish --access public' }), 'deny', 'Codex exec_command');
  assert.equal(never('', 'exec_command', { argv: ['bash', '-lc', 'git push -f origin main'] }), 'deny', 'Codex argv');
  for (const command of ['git push --force-with-lease origin main', 'git push --force-with-lease=main:abc origin main', 'git push -uf origin x', 'git push origin +main', 'git -C /x push origin +HEAD:main', 'cd x && sh -c "git push --force"', 'gh -R a/b release create v1']) {
    assert.equal(never(command), 'deny', command);
  }
  for (const command of ['git push', 'git push -u origin base-044-x', 'git push origin main:refs/heads/release/r001', 'gh release view v1', 'npm run publish-docs', 'echo "npm publish"', "cat > notes.md <<'EOF'\ngit push --force\nEOF"]) {
    assert.equal(never(command), 'none', command);
  }
  assert.equal(never('', 'apply_patch', { command: '*** Begin Patch\n*** Update File: a.md\n@@\n npm publish\n*** End Patch' }), 'none', 'patch text is data');
  assert.match(hook(join(hooks, 'never.mjs'), { tool_name: 'Bash', tool_input: { command: 'npm publish' } }, home).permissionDecisionReason, /never hook: `npm publish`/);
});

function typedRepo(slug) {
  const dir = tempDir('typed');
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('remote', 'add', 'origin', `https://github.com/${slug}.git`);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node typecheck.cjs', test: 'node -e "process.exit(9)"' } }));
  writeFileSync(join(dir, 'typecheck.cjs'), "if (require('fs').existsSync('BROKEN')) { console.log(\"src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\"); process.exit(2); }\n");
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
  return { dir, git };
}

test('typecheck blocks a stop once on a type error in changed TypeScript and is silent otherwise', () => {
  const home = tempDir('home');
  const stop = (cwd, active = false) => {
    const result = spawnSync(process.execPath, [join(hooks, 'typecheck.mjs')], { input: JSON.stringify({ hook_event_name: 'Stop', cwd, stop_hook_active: active }), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
  const maplab = typedRepo('Wizard-Gang/MapLab');
  writeFileSync(join(maplab.dir, 'BROKEN'), '');
  assert.equal(stop(maplab.dir), null, 'no TypeScript change, no typecheck');
  mkdirSync(join(maplab.dir, 'src'));
  writeFileSync(join(maplab.dir, 'src', 'a.ts'), 'export const a: number = 1;\n');
  const blocked = stop(maplab.dir);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /Typecheck failed in Wizard-Gang\/MapLab[\s\S]*error TS2322/);
  assert.equal(stop(maplab.dir, true), null, 'never again while stop_hook_active is set');
  rmSync(join(maplab.dir, 'BROKEN'));
  assert.equal(stop(maplab.dir), null, 'a pass is silent');

  const riglab = typedRepo('Wizard-Gang/RigLab');
  writeFileSync(join(riglab.dir, 'BROKEN'), '');
  writeFileSync(join(riglab.dir, 'b.tsx'), 'export {};\n');
  riglab.git('add', '.');
  riglab.git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'tsx');
  assert.equal(stop(riglab.dir).decision, 'block', 'unpushed commits count');

  const other = typedRepo('Wizard-Gang/WizardGang');
  writeFileSync(join(other.dir, 'BROKEN'), '');
  writeFileSync(join(other.dir, 'c.ts'), 'export {};\n');
  assert.equal(stop(other.dir), null, 'repositories outside typecheck.json');
  assert.equal(stop(home), null, 'outside a repository');
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
  const patch = (header, body) => `*** Begin Patch\n*** ${header}\n${body}\n*** End Patch`;
  const codex = (command, cwd = home) => decision(hook(join(hooks, 'rulebook-cap.mjs'), { tool_name: 'apply_patch', cwd, tool_input: { command } }, home));
  assert.equal(codex(patch('Update File: .claude/CLAUDE.md', `@@\n+${words(100)}`)), 'none', 'Codex apply_patch at the cap');
  assert.equal(codex(patch(`Update File: ${homePath}`, `@@\n+${words(101)}`)), 'deny', 'Codex apply_patch past the cap');
  assert.equal(codex(patch('Update File: .claude/CLAUDE.md', `@@\n-${words(600)}\n+${words(700)}`)), 'none');
  assert.equal(codex(patch('Add File: agent/RULEBOOK.md', `+${words(701)}`), root), 'deny', 'the tracked rulebook through apply_patch');
  assert.equal(codex(patch('Add File: notes.md', `+${words(900)}`)), 'none');
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
