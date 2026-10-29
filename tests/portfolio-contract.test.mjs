import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  firstOpenTask, highestUsedId, openTasks, validatePortfolioContract, validateQueue, validateQueueEdit,
} from '../contract/check-portfolio-contract.mjs';

const template = readFileSync(resolve(import.meta.dirname, 'fixtures/empty-plan.md'), 'utf8');
const empty = (highest) => template.replace('<ID>', highest);
const plan = (highest, ...ids) => `# Implementation plan\n\n## Open tasks\n\n**Highest ID ever used:** ${highest}.\n\n${
  ids.map((id) => `### ${id} — [OPS] Do ${id}\n\n- Why: queued.\n`).join('\n')}`;
const edit = (title, basePlan, headPlan, changedFiles = ['implementation_plan.md']) =>
  validateQueueEdit({ title, changedFiles, basePlan, headPlan });

test('the committed contract files and queue pass', () => {
  assert.ok(validatePortfolioContract() >= 0);
});

test('task headings and the highest-ID marker parse', () => {
  assert.equal(firstOpenTask('# Implementation plan\n\n## Open tasks\n\nNo tasks.\n'), null);
  assert.equal(firstOpenTask('### HF-148 — [OPS] First\n### HF-149 — [OPS] Second\n')?.id, 'HF-148');
  assert.equal(firstOpenTask('HF-148 appears in prose, not a task heading.\n'), null);
  assert.deepEqual(highestUsedId(plan('ML-047')), { id: 'ML-047', prefix: 'ML', number: 47 });
  assert.equal(highestUsedId('# Implementation plan\n'), null);
  assert.equal(highestUsedId(`${plan('ML-047')}\n**Highest ID ever used:** ML-048.\n`), null);
});

test('the empty template is shared across namespaces and must carry the marker', () => {
  assert.deepEqual(validateQueue(empty('BASE-044')), []);
  assert.deepEqual(validateQueue(empty('RLDR-023')), []);
  assert.match(validateQueue(template.replace('**Highest ID ever used:** <ID>.\n\n', '')).join('\n'), /exactly one/);
  assert.match(validateQueue(`${empty('BASE-044')}Extra prose.\n`).join('\n'), /shared template/);
});

test('a queue may be reordered and non-contiguous but stays in one namespace below its marker', () => {
  assert.deepEqual(validateQueue(plan('BASE-050', 'BASE-049', 'BASE-043')), []);
  assert.match(validateQueue(plan('BASE-050', 'BASE-043', 'BASE-043')).join('\n'), /unique/);
  assert.match(validateQueue(plan('BASE-050', 'ML-043')).join('\n'), /namespace/);
  assert.match(validateQueue(plan('BASE-044', 'BASE-045')).join('\n'), /above the recorded BASE-044/);
});

test('a [PLAN] PR edits only the plan and takes new IDs above the recorded highest', () => {
  const base = plan('BASE-044', 'BASE-043', 'BASE-044');
  assert.deepEqual(edit('[PLAN] Queue the next work', base, plan('BASE-050', 'BASE-044', 'BASE-050', 'BASE-043')), []);
  assert.deepEqual(edit('[PLAN] Drop a task', base, plan('BASE-044', 'BASE-044')), []);
  assert.deepEqual(edit('[PLAN] Fill the queue', empty('BASE-044'), plan('BASE-047', 'BASE-047')), []);
  assert.match(edit('[PLAN] Queue', base, plan('BASE-045', 'BASE-043', 'BASE-044', 'BASE-045'),
    ['implementation_plan.md', 'README.md']).join('\n'), /changes only implementation_plan.md/);
});

test('recycled, lower and falling IDs are rejected', () => {
  const base = plan('BASE-044', 'BASE-044');
  assert.match(edit('[PLAN] Recycle', base, plan('BASE-044', 'BASE-044', 'BASE-042')).join('\n'), /BASE-042: a new task takes an ID above BASE-044/);
  assert.match(edit('[PLAN] Reuse', base, plan('BASE-044', 'BASE-044', 'BASE-044')).join('\n'), /unique/);
  assert.match(edit('[PLAN] Lower', base, plan('BASE-040')).join('\n'), /never fall below BASE-044/);
});

test('a task PR delivers a queued or new ID and removes its own task', () => {
  const base = plan('BASE-044', 'BASE-043', 'BASE-044');
  const files = ['implementation_plan.md', 'contract/check-change.mjs'];
  assert.deepEqual(edit('[BASE-043] [OPS] Deliver', base, plan('BASE-044', 'BASE-044'), files), []);
  assert.deepEqual(edit('[BASE-044] [OPS] Deliver out of order', base, plan('BASE-044', 'BASE-043'), files), []);
  assert.deepEqual(edit('[BASE-051] [FIX] Repair', base, plan('BASE-051', 'BASE-043', 'BASE-044'), files), []);
  assert.match(edit('[BASE-043] [OPS] Keep', base, base, files).join('\n'), /removes its own task/);
  assert.match(edit('[BASE-041] [FIX] Recycle', base, base, files).join('\n'), /neither queued nor a new ID above BASE-044/);
  assert.match(edit('[BASE-051] [FIX] Unrecorded', base, base, files).join('\n'), /raise its highest ID/);
  assert.match(edit('[ML-045] [FIX] Wrong namespace', base, base, files).join('\n'), /namespace/);
  assert.match(edit('Untitled change', base, base, files).join('\n'), /title must be/);
  assert.deepEqual(openTasks(plan('BASE-044', 'BASE-044')).map((task) => task.id), ['BASE-044']);
});
