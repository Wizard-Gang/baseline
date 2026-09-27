// The pure, provider-independent rules for a controlled BASE change.
export const CONTROLLED_TYPES = Object.freeze([
  'INIT', 'FEAT', 'FIX', 'SEC', 'API', 'A11Y', 'I18N', 'AI', 'DB',
  'OPS', 'TEST', 'DOCS', 'REFACTOR', 'PERF', 'BUILD', 'REVERT', 'CHORE',
]);

export const REQUIRED_BODY_FIELDS = Object.freeze([
  'Change', 'Reason', 'Impact', 'Risk', 'Controls', 'Validation',
  'Evidence', 'Source', 'Release',
]);

export const REQUIRED_PLAN_FIELDS = Object.freeze([
  'Dependency', 'Why', 'Scope', 'Non-goals', 'Acceptance', 'Validation', 'Authorities',
]);

const titlePattern = /^\[BASE-(\d{3,})\] \[([A-Z][A-Z0-9]*)\] (\S[^\r\n]*)$/;
const branchPattern = /^base-(\d{3,})-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const taskPattern = /^### BASE-(\d{3,}) — \[([A-Z][A-Z0-9]*)\] (\S[^\r\n]*)$/gm;

const id = (number) => `BASE-${String(number).padStart(3, '0')}`;
const normalizeBody = (value) => value.replaceAll('\r\n', '\n').replace(/\n+$/, '');

export function parseTitle(subject) {
  const match = titlePattern.exec(subject);
  if (!match || match[1] !== String(Number(match[1])).padStart(3, '0')
    || !CONTROLLED_TYPES.includes(match[2]) || /\[[A-Z][A-Z0-9]*\]/.test(match[3])) return null;
  return { id: id(Number(match[1])), number: Number(match[1]), type: match[2], summary: match[3] };
}

export function parseBranch(branch) {
  const match = branchPattern.exec(branch);
  return match && match[1] === String(Number(match[1])).padStart(3, '0')
    ? { id: id(Number(match[1])), number: Number(match[1]) } : null;
}

export function validateBody(body, label = 'commit') {
  const failures = [];
  const lines = body.replaceAll('\r\n', '\n').split('\n');
  const positions = new Map();
  for (const field of REQUIRED_BODY_FIELDS) {
    const matches = lines.flatMap((line, index) => line === `${field}:` ? [index] : []);
    if (matches.length !== 1) failures.push(`${label}: expected exactly one ${field}: field`);
    else positions.set(field, matches[0]);
  }
  let previous = -1;
  for (const [index, field] of REQUIRED_BODY_FIELDS.entries()) {
    const position = positions.get(field);
    if (position === undefined) continue;
    if (position <= previous) failures.push(`${label}: ${field}: is out of order`);
    previous = position;
    const next = REQUIRED_BODY_FIELDS.slice(index + 1)
      .map((name) => positions.get(name))
      .find((candidate) => candidate !== undefined && candidate > position) ?? lines.length;
    if (!lines.slice(position + 1, next).some((line) => line.trim())) {
      failures.push(`${label}: ${field}: has no value`);
    }
  }
  const riskPosition = positions.get('Risk');
  if (riskPosition !== undefined && !/^(Low|Medium|High)$/.test(lines[riskPosition + 1]?.trim() ?? '')) {
    failures.push(`${label}: Risk: must start with Low, Medium, or High`);
  }
  return failures;
}

export function validateHistory(records) {
  const failures = [];
  let lastId = 0;
  if (records.length === 0) failures.push('controlled history is empty');
  records.forEach((record, index) => {
    const label = record.sha || `commit ${index + 1}`;
    const expectedParents = index === 0 ? 0 : 1;
    if (record.parents.length !== expectedParents || (index > 0 && record.parents[0] !== records[index - 1].sha)) {
      failures.push(`${label}: controlled main must be a single first-parent chain without merge commits`);
    }
    const title = parseTitle(record.subject);
    if (!title) {
      failures.push(`${label}: invalid controlled title`);
      return;
    }
    if (title.number !== lastId + 1) failures.push(`${label}: expected ${id(lastId + 1)}, found ${title.id}`);
    // Advance on a bad number so later failures describe the actual sequence.
    lastId = title.number;
    failures.push(...validateBody(record.body, title.id));
  });
  return { failures, lastId };
}

export function validatePlan(markdown, nextId) {
  if (markdown === null || markdown === undefined) {
    return { failures: ['permanent implementation_plan.md is missing'], tasks: [] };
  }
  const failures = [];
  if (!markdown.startsWith('# Implementation plan\n\n## Open tasks\n')) {
    failures.push('implementation_plan.md must retain the common permanent queue heading');
  }
  const headings = [...markdown.matchAll(/^### .+$/gm)];
  const tasks = [...markdown.matchAll(taskPattern)].map((match) => ({
    id: `BASE-${match[1]}`, number: Number(match[1]), type: match[2], summary: match[3],
    start: match.index, end: match.index + match[0].length,
  }));
  if (!tasks.length && !markdown.includes('The queue is empty. Select no implementation task.')) {
    failures.push('empty implementation_plan.md must instruct the next change to fill the queue');
  }
  if (headings.length !== tasks.length) failures.push('every ### heading must be a BASE task');
  if (/^#{1,6}\s+(?:Done|Completed|History|Retrospective|Release notes)\b/im.test(markdown)) {
    failures.push('active implementation_plan.md cannot retain completed or historical sections');
  }
  tasks.forEach((task, index) => {
    const expected = nextId + index;
    if (task.number !== expected) failures.push(`${task.id}: expected ${id(expected)} as task ${index + 1}`);
    if (task.id !== id(task.number)) failures.push(`${task.id}: use canonical numeric padding ${id(task.number)}`);
    if (!CONTROLLED_TYPES.includes(task.type)) failures.push(`${task.id}: invalid primary type ${task.type}`);
    const section = markdown.slice(task.end, tasks[index + 1]?.start ?? markdown.length);
    for (const field of REQUIRED_PLAN_FIELDS) {
      if (!new RegExp(`^(?:- )?${field}:\\s*\\S`, 'm').test(section)) failures.push(`${task.id}: missing nonempty ${field} field`);
    }
    if (/^\s*- (?:Status|Merged|Completed|PR|Merge SHA):/im.test(section)) {
      failures.push(`${task.id}: completed-task metadata belongs in Git/GitHub`);
    }
  });
  return { failures, tasks: tasks.map(({ id: taskId, number, type, summary }) => ({ id: taskId, number, type, summary })) };
}

export function validatePullRequest(context) {
  const failures = [];
  if (context.targetBranch !== 'main') failures.push('controlled PR must target main');
  const baseHistory = validateHistory(context.baseHistory);
  failures.push(...baseHistory.failures);
  const expected = baseHistory.lastId + 1;
  const title = parseTitle(context.title);
  const branch = parseBranch(context.branch);
  if (!title) failures.push('PR title must be [BASE-###] [TYPE] Imperative summary');
  if (!branch) failures.push('branch must be base-###-imperative-summary');
  if (context.title !== context.head.subject) failures.push('PR title must exactly equal the head commit subject');
  if (typeof context.prBody !== 'string') failures.push('PR body must contain the controlled commit body');
  else if (normalizeBody(context.prBody) !== normalizeBody(context.head.body)) {
    failures.push('PR body must exactly equal the head commit body (ignoring line endings and trailing newlines)');
  }
  if (title && branch && title.id !== branch.id) failures.push(`branch ${branch.id} does not match PR ${title.id}`);
  if (title && title.number !== expected) failures.push(`PR must use next sequential ${id(expected)}`);
  if (context.mergeBaseSha !== context.baseSha || context.head.parents.length !== 1 || context.head.parents[0] !== context.baseSha) {
    failures.push('PR head must be a direct child of the current base commit');
  }
  if (context.commitRangeCount !== 1) failures.push(`PR range must contain one controlled commit; found ${context.commitRangeCount}`);
  failures.push(...validateBody(context.head.body, title?.id ?? 'head commit'));

  const basePlan = validatePlan(context.basePlan, expected);
  failures.push(...basePlan.failures.map((failure) => `base plan: ${failure}`));
  const headPlan = validatePlan(context.headPlan, expected + 1);
  failures.push(...headPlan.failures.map((failure) => `head plan: ${failure}`));
  if (basePlan.tasks.length === 0) {
    if (headPlan.tasks.length === 0) {
      failures.push('a change from an empty queue must publish a future-task plan');
    }
  } else {
    const first = basePlan.tasks[0];
    if (first && title && first.type !== title.type) failures.push(`${first.id}: first task type must match PR type`);
    const remaining = basePlan.tasks.slice(1);
    if (remaining.length === 0 && headPlan.tasks.length !== 0) {
      failures.push('delivering the final task must leave the queue empty');
    }
    if (remaining.length > 0 && headPlan.tasks.length === 0) failures.push('delivering a task must preserve remaining future tasks');
    remaining.forEach((task, index) => {
      if (headPlan.tasks[index]?.id !== task.id) failures.push(`${task.id}: future task was removed or reordered`);
    });
  }
  return { failures, nextId: id(expected) };
}
