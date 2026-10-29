import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { readDeliveryConfig, validateDeliveryConfig } from '../contract/delivery-config.mjs';
import { contractScripts, validateDeliveryContract } from '../contract/repository-contract.mjs';
import { validateRepositoryAt } from '../scripts/repository-contract.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const baseline = JSON.parse(read('config/delivery.json'));
// The shape a lab's config takes: another prefix and direct-task cut-over, extra plan fields, no release workflow.
const consumer = {
  name: 'examplelab',
  repository: 'Wizard-Gang/ExampleLab',
  idPrefix: 'EXL',
  lastDirectTask: 7,
  planFields: [...baseline.planFields, 'Tests', 'Documentation'],
  releaseWorkflow: false,
  migrationPins: false,
};
const failures = (config) => validateDeliveryConfig(config).join('\n');

function tree(t, config, names) {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-delivery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'contract'));
  mkdirSync(join(dir, 'config'));
  for (const name of names) copyFileSync(join(root, 'contract', name), join(dir, 'contract', name));
  writeFileSync(join(dir, 'config/delivery.json'), JSON.stringify(config));
  return dir;
}

function run(cwd, script, env = {}) {
  const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  return result;
}

test('the committed config and a consumer-shaped config validate', () => {
  assert.deepEqual(validateDeliveryConfig(baseline), []);
  assert.deepEqual(validateDeliveryConfig(consumer), []);
});

test('a malformed config is rejected field by field', () => {
  const without = (key) => Object.fromEntries(Object.entries(baseline).filter(([name]) => name !== key));
  assert.match(failures(without('migrationPins')), /must declare exactly/);
  assert.match(failures({ ...baseline, extra: true }), /must declare exactly/);
  for (const value of [null, [], 'baseline']) assert.match(failures(value), /must be an object/);
  assert.match(failures({ ...baseline, name: 'Baseline' }), /name must be the lower-case/);
  assert.match(failures({ ...baseline, repository: 'Other/baseline' }), /repository must be Wizard-Gang\//);
  for (const idPrefix of ['', 'base', 'PLAN', 'RELEASE']) {
    assert.match(failures({ ...baseline, idPrefix }), /idPrefix must be an upper-case task ID prefix/);
  }
  for (const lastDirectTask of [-1, 1.5, '43', null]) {
    assert.match(failures({ ...baseline, lastDirectTask }), /lastDirectTask must be/);
  }
  for (const planFields of [[], ['Why', 'Why'], ['why'], [1], 'Why']) {
    assert.match(failures({ ...baseline, planFields }), /planFields must list unique capitalized/);
  }
  assert.match(failures({ ...baseline, releaseWorkflow: 'yes' }), /releaseWorkflow must be true or false/);
  assert.match(failures({ ...baseline, migrationPins: 1 }), /migrationPins must be true or false/);
});

test('reading the config fails closed on a missing, unparseable or malformed file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-delivery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => readDeliveryConfig(dir), { code: 'ENOENT' });
  mkdirSync(join(dir, 'config'));
  writeFileSync(join(dir, 'config/delivery.json'), '{not json');
  assert.throws(() => readDeliveryConfig(dir), { name: 'SyntaxError' });
  writeFileSync(join(dir, 'config/delivery.json'), JSON.stringify({ ...baseline, idPrefix: 'PLAN' }));
  assert.throws(() => readDeliveryConfig(dir), { message: /^config\/delivery\.json: .*idPrefix/ });
  writeFileSync(join(dir, 'config/delivery.json'), JSON.stringify(consumer));
  const config = readDeliveryConfig(dir);
  assert.equal(config.idPrefix, 'EXL');
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.planFields));
});

test("a consumer's config sets the ID prefix, direct-task cut-over and plan fields of the shared change contract", async (t) => {
  const names = ['change-contract.mjs', 'check-portfolio-contract.mjs', 'delivery-config.mjs'];
  const dir = tree(t, consumer, names);
  const contract = await import(pathToFileURL(join(dir, 'contract/change-contract.mjs')));
  assert.equal(contract.ID_PREFIX, 'EXL');
  assert.equal(contract.LAST_DIRECT_TASK, 7);
  assert.deepEqual(contract.REQUIRED_PLAN_FIELDS, consumer.planFields);
  assert.deepEqual(contract.parseTitle('[EXL-008] [OPS] Add a thing'), { id: 'EXL-008', number: 8, type: 'OPS', summary: 'Add a thing' });
  assert.equal(contract.parseTitle('[BASE-008] [OPS] Add a thing'), null);
  assert.deepEqual(contract.parseBranch('exl-008-add-a-thing'), { id: 'EXL-008', number: 8 });
  assert.equal(contract.parseBranch('base-008-add-a-thing'), null);

  const queue = (fields, prefix = 'EXL') => `# Implementation plan\n\n## Open tasks\n\n**Highest ID ever used:** ${prefix}-008.\n\n### ${prefix}-008 — [OPS] Add a thing\n\n${
    fields.map((field) => `- ${field}: set.\n`).join('')}`;
  assert.deepEqual(contract.validatePlan(queue(consumer.planFields)).failures, []);
  const missing = contract.validatePlan(queue(baseline.planFields)).failures.join('\n');
  assert.match(missing, /EXL-008: missing nonempty Tests field/);
  assert.match(missing, /EXL-008: missing nonempty Documentation field/);
  assert.match(contract.validatePlan(queue(consumer.planFields, 'BASE')).failures.join('\n'), /every ### heading must be a EXL task/);

  const own = await import('../contract/change-contract.mjs');
  assert.equal(own.ID_PREFIX, 'BASE');
  assert.equal(own.LAST_DIRECT_TASK, 43);
  assert.equal(own.parseTitle('[EXL-008] [OPS] Add a thing'), null);
});

test('releaseWorkflow decides whether the release workflow and check:release are required', () => {
  const specimen = () => ({
    ci: read('.github/workflows/verify.yml'),
    release: read('.github/workflows/release.yml'),
    cutter: read('.github/workflows/release-cutter.yml'),
    pkg: JSON.parse(read('package.json')),
    lock: JSON.parse(read('package-lock.json')),
    provider: JSON.parse(read('config/github-repository-settings.json')),
  });
  const without = { ...baseline, releaseWorkflow: false };
  assert.deepEqual(validateDeliveryContract(specimen()), []);
  assert.equal('check:release' in contractScripts(baseline), true);
  assert.equal('check:release' in contractScripts(without), false);

  // A repository with no release workflow carries neither workflow file nor the check:release script.
  const bare = specimen();
  delete bare.release;
  delete bare.cutter;
  delete bare.pkg.scripts['check:release'];
  assert.deepEqual(validateDeliveryContract(bare, without), []);
  const scriptless = specimen();
  delete scriptless.pkg.scripts['check:release'];
  assert.ok(validateDeliveryContract(scriptless, baseline).includes('missing package script check:release'));

  const broken = specimen();
  broken.release = broken.release.replace(/^permissions:\n {2}contents: read/m, 'permissions:\n  contents: write');
  assert.notEqual(broken.release, specimen().release);
  assert.ok(validateDeliveryContract(broken, baseline).includes('Release default token must be read-only'));
  assert.deepEqual(validateDeliveryContract(broken, without), []);
});

test('migrationPins decides whether check-patch needs the migration contract', (t) => {
  const patch = (migrationPins) => {
    const dir = tree(t, { ...consumer, migrationPins }, ['check-patch.mjs', 'delivery-config.mjs']);
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Baseline Test');
    git('config', 'user.email', 'baseline@example.invalid');
    git('add', '-A');
    git('commit', '-q', '-m', 'one');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'change.txt'), 'change\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'two');
    return run(dir, 'contract/check-patch.mjs', { PATCH_BASE_SHA: base, PATCH_HEAD_SHA: git('rev-parse', 'HEAD') });
  };
  const unpinned = patch(false);
  assert.equal(unpinned.status, 0, unpinned.stderr);
  assert.match(unpinned.stdout, /Committed patch whitespace passed/);
  assert.doesNotMatch(unpinned.stdout, /migration pins/);
  // A repository that owns migration pins must carry scripts/migration-contract.mjs; this tree does not.
  const pinned = patch(true);
  assert.notEqual(pinned.status, 0);
  assert.match(pinned.stderr, /migration-contract/);
});

test("baseline's repository contract pins config/delivery.json to baseline's own identity", (t) => {
  const copy = mkdtempSync(join(tmpdir(), 'baseline-delivery-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(root, copy, {
    recursive: true,
    filter: (source) => !/^(?:\.git|node_modules)(?:[\\/]|$)/.test(relative(root, source)),
  });
  assert.deepEqual(validateRepositoryAt(copy), []);
  const pin = ["config/delivery.json must keep baseline's delivery identity"];
  writeFileSync(join(copy, 'config/delivery.json'), JSON.stringify({ ...baseline, lastDirectTask: 7 }));
  assert.deepEqual(validateRepositoryAt(copy), pin);
  writeFileSync(join(copy, 'config/delivery.json'), JSON.stringify(consumer));
  assert.deepEqual(validateRepositoryAt(copy), pin);
});

test('a consumer whose AGENTS.md, CONTRIBUTING.md or empty plan template drifts fails the portfolio check', (t) => {
  const dir = tree(t, consumer, ['check-portfolio-contract.mjs']);
  const files = ['AGENTS.md', 'CONTRIBUTING.md', 'implementation_plan.md'];
  const restore = () => { for (const file of files) copyFileSync(join(root, file), join(dir, file)); };
  const check = () => run(dir, 'contract/check-portfolio-contract.mjs');
  restore();
  const clean = check();
  assert.equal(clean.status, 0, clean.stderr);
  for (const file of ['AGENTS.md', 'CONTRIBUTING.md']) {
    writeFileSync(join(dir, file), `${read(file)}A drifted line.\n`);
    const drifted = check();
    assert.equal(drifted.status, 1);
    assert.match(drifted.stderr, new RegExp(`${file.replace('.', '\\.')} differs from the portfolio contract`));
    restore();
  }
  writeFileSync(join(dir, 'implementation_plan.md'), '# Implementation plan\n\n## Open tasks\n\n**Highest ID ever used:** EXL-001.\n\nDrifted prose.\n');
  const template = check();
  assert.equal(template.status, 1);
  assert.match(template.stderr, /empty queue must use the permanent shared template/);
});
