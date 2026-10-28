// The pure, provider-independent rules for a controlled BASE change.
import { validateQueueEdit } from './check-portfolio-contract.mjs';

export const CONTROLLED_TYPES = Object.freeze([
  'INIT', 'FEAT', 'FIX', 'SEC', 'API', 'A11Y', 'I18N', 'AI', 'DB',
  'OPS', 'TEST', 'DOCS', 'REFACTOR', 'PERF', 'BUILD', 'REVERT', 'CHORE',
]);

export const REQUIRED_BODY_FIELDS = Object.freeze([
  'Change', 'Reason', 'Impact', 'Risk', 'Controls', 'Validation',
  'Evidence', 'Source', 'Release',
]);

export const REQUIRED_PLAN_FIELDS = Object.freeze([
  'Dependency', 'Why', 'Scope', 'Non-goals', 'Acceptance', 'Tests', 'Validation', 'Documentation', 'Authorities',
]);

// Tasks through BASE-043 merged straight into main. Later tasks squash into the open release/rNNN branch, and
// main changes only by a release PR that rebase-merges one commit per task or plan change.
export const LAST_DIRECT_TASK = 43;

const titlePattern = /^\[BASE-(\d{3,})\] \[([A-Z][A-Z0-9]*)\] (\S[^\r\n]*)$/;
const planTitlePattern = /^\[PLAN\] (\S[^\r\n]*)$/;
const planBranchPattern = /^plan-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const releaseBranchPattern = /^release\/r(\d{3,})$/;
const branchPattern = /^base-(\d{3,})-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const taskPattern = /^### BASE-(\d{3,}) — \[([A-Z][A-Z0-9]*)\] (\S[^\r\n]*)$/gm;

const id = (number) => `BASE-${String(number).padStart(3, '0')}`;
const normalizeBody = (value) => value.replaceAll('\r\n', '\n').replace(/\n+$/, '');
const releaseId = (number) => `r${String(number).padStart(3, '0')}`;
const sameList = (actual, expected) => Array.isArray(actual) && actual.length === expected.length
  && expected.every((value, index) => actual[index] === value);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseTitle(subject) {
  const match = titlePattern.exec(subject);
  if (!match || match[1] !== String(Number(match[1])).padStart(3, '0')
    || !CONTROLLED_TYPES.includes(match[2]) || /\[[A-Z][A-Z0-9]*\]/.test(match[3])) return null;
  return { id: id(Number(match[1])), number: Number(match[1]), type: match[2], summary: match[3] };
}

/** A plan-only change edits only implementation_plan.md and takes no task ID: `[PLAN] Imperative summary`. */
export function parsePlanTitle(subject) {
  const match = planTitlePattern.exec(subject ?? '');
  return match && !/\[[A-Z][A-Z0-9]*\]/.test(match[1]) ? { summary: match[1] } : null;
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

// IDs are unique and never recycled, but the queue can be reordered, so history need not be contiguous or ascending.
export function validateHistory(records) {
  const failures = [];
  const ids = new Set();
  let lastId = 0;
  if (records.length === 0) failures.push('controlled history is empty');
  records.forEach((record, index) => {
    const label = record.sha || `commit ${index + 1}`;
    const expectedParents = index === 0 ? 0 : 1;
    if (record.parents.length !== expectedParents || (index > 0 && record.parents[0] !== records[index - 1].sha)) {
      failures.push(`${label}: controlled main must be a single first-parent chain without merge commits`);
    }
    const title = parseTitle(record.subject);
    if (!title && index > 0 && parsePlanTitle(record.subject)) {
      failures.push(...validateBody(record.body, `${label} [PLAN]`));
      return;
    }
    if (!title) {
      failures.push(`${label}: invalid controlled title`);
      return;
    }
    if (index === 0 && title.number !== 1) failures.push(`${label}: history must begin at BASE-001, found ${title.id}`);
    if (ids.has(title.number)) failures.push(`${label}: ${title.id} was already used; IDs are never recycled`);
    ids.add(title.number);
    lastId = Math.max(lastId, title.number);
    failures.push(...validateBody(record.body, title.id));
  });
  return { failures, ids, lastId };
}

/** Queued tasks may be added, edited, reordered or removed by any change; their IDs stay unique and undelivered. */
export function validatePlan(markdown, delivered = new Set()) {
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
  if (headings.length !== tasks.length) failures.push('every ### heading must be an BASE task');
  if (/^#{1,6}\s+(?:Done|Completed|History|Retrospective|Release notes)\b/im.test(markdown)) {
    failures.push('active implementation_plan.md cannot retain completed or historical sections');
  }
  tasks.forEach((task, index) => {
    if (tasks.findIndex((other) => other.number === task.number) !== index) failures.push(`${task.id}: queued more than once`);
    if (delivered.has(task.number)) failures.push(`${task.id}: was already delivered; IDs are never recycled`);
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

export function parseReleaseBranch(ref) {
  const match = releaseBranchPattern.exec(ref ?? '');
  return match && match[1] === String(Number(match[1])).padStart(3, '0') && Number(match[1]) > 0
    ? { id: releaseId(Number(match[1])), number: Number(match[1]) } : null;
}

/** config/release.json names the open release: `{ id: "r001", branch: "release/r001", tasks: ["BASE-008", ...] }`. */
export function validateReleaseConfig(config, label = 'config/release.json') {
  if (!isObject(config)) return [`${label} must be an {id, branch, tasks} object`];
  const failures = [];
  if (Object.keys(config).sort().join() !== 'branch,id,tasks') failures.push(`${label} must hold only id, branch and tasks`);
  if (parseReleaseBranch(config.branch)?.id !== config.id) failures.push(`${label}: branch must be release/${config.id} for id ${config.id}`);
  const tasks = Array.isArray(config.tasks) ? config.tasks : [];
  if (!tasks.length) failures.push(`${label}: tasks must list the release's BASE IDs`);
  tasks.forEach((task, index) => {
    const number = Number(String(task).slice(5));
    if (task !== id(number) || tasks.indexOf(task) !== index) {
      failures.push(`${label}: tasks must be unique canonical BASE IDs`);
    }
  });
  return [...new Set(failures)];
}


function validateReleaseTask(context, title, failures) {
  const head = context.headRelease;
  const configFailures = validateReleaseConfig(head, 'head config/release.json');
  failures.push(...configFailures);
  if (configFailures.length || !title) return;
  if (head.branch !== context.targetBranch) failures.push(`PR must target the config/release.json branch ${head.branch}`);
  const base = isObject(context.baseRelease) ? context.baseRelease : null;
  const continuing = base?.id === head.id;
  const tasks = continuing ? [...base.tasks, title.id] : [title.id];
  if (!sameList(head.tasks, tasks)) failures.push(`config/release.json tasks must be ${tasks.join(', ')}`);
  if (continuing) return;
  const next = releaseId((base ? parseReleaseBranch(base.branch)?.number ?? 0 : 0) + 1);
  if (head.id !== next) failures.push(`the first task of a release must open ${next}`);
}

/** The release PR, release/rNNN into main: one task commit per config/release.json task, oldest first, plus any plan-only commits. */
export function validateReleasePullRequest(context) {
  const failures = [];
  const release = parseReleaseBranch(context.branch);
  const head = context.headRelease;
  const configFailures = validateReleaseConfig(head, 'head config/release.json');
  failures.push(...configFailures);
  const tasks = configFailures.length ? [] : head.tasks;
  if (!configFailures.length) {
    if (head.branch !== context.branch) failures.push(`release PR head must be the config/release.json branch ${head.branch}`);
    const expectedTitle = `[RELEASE] ${release.id}: ${tasks[0]}${tasks.length > 1 ? `..${tasks.at(-1)}` : ''}`;
    if (context.title !== expectedTitle) failures.push(`release PR title must be ${expectedTitle}`);
  }
  const base = validateHistory(context.baseHistory);
  const history = validateHistory([...context.baseHistory, ...context.rangeRecords]);
  failures.push(...history.failures);
  if (context.mergeBaseSha !== context.baseSha || context.rangeRecords[0]?.parents[0] !== context.baseSha) {
    failures.push('release branch must be current with main');
  }
  if (context.commitRangeCount !== context.rangeRecords.length) failures.push('release range must be one first-parent chain');
  const ids = context.rangeRecords.flatMap((record) => parseTitle(record.subject)?.id ?? (parsePlanTitle(record.subject) ? [] : record.sha));
  if (!sameList(ids, tasks)) {
    failures.push(`release commits must be one per listed task (${tasks.join(', ')}); found ${ids.join(', ') || 'none'}`);
  }
  failures.push(...validatePlan(context.basePlan, base.ids).failures.map((failure) => `base plan: ${failure}`));
  failures.push(...validatePlan(context.headPlan, history.ids).failures.map((failure) => `head plan: ${failure}`));
  return { failures, nextId: release.id };
}

export function validatePullRequest(context) {
  if (context.targetBranch === 'main' && parseReleaseBranch(context.branch)) return validateReleasePullRequest(context);
  const failures = [];
  const release = parseReleaseBranch(context.targetBranch);
  if (context.targetBranch !== 'main' && !release) failures.push('controlled PR must target main or a release/rNNN branch');
  const baseHistory = validateHistory(context.baseHistory);
  failures.push(...baseHistory.failures);
  const planOnly = parsePlanTitle(context.title);
  const title = parseTitle(context.title);
  const branch = parseBranch(context.branch);
  if (!title && !planOnly) failures.push('PR title must be [BASE-###] [TYPE] Imperative summary or [PLAN] Imperative summary');
  if (planOnly && !planBranchPattern.test(context.branch ?? '')) failures.push('plan-only branch must be plan-imperative-summary');
  if (!planOnly && !branch) failures.push('branch must be base-###-imperative-summary');
  if (context.title !== context.head.subject) failures.push('PR title must exactly equal the head commit subject');
  if (typeof context.prBody !== 'string') failures.push('PR body must contain the controlled commit body');
  else if (normalizeBody(context.prBody) !== normalizeBody(context.head.body)) {
    failures.push('PR body must exactly equal the head commit body (ignoring line endings and trailing newlines)');
  }
  if (title && branch && title.id !== branch.id) failures.push(`branch ${branch.id} does not match PR ${title.id}`);
  if (planOnly && !release) failures.push('a plan-only PR must target the open release/rNNN branch; main changes only by release PR');
  if (title && !release && title.number > LAST_DIRECT_TASK) {
    failures.push(`${title.id} must target the open release/rNNN branch; main changes only by release PR`);
  }
  if (context.mergeBaseSha !== context.baseSha || context.head.parents.length !== 1 || context.head.parents[0] !== context.baseSha) {
    failures.push('PR head must be a direct child of the current base commit');
  }
  if (context.commitRangeCount !== 1) failures.push(`PR range must contain one controlled commit; found ${context.commitRangeCount}`);
  failures.push(...validateBody(context.head.body, title?.id ?? 'head commit'));

  // Any change may add, edit, reorder or remove queued tasks. A new task takes an ID above the plan's recorded
  // highest ID ever used, so a removed queued ID stays retired (scripts/check-portfolio-contract.mjs).
  const basePlan = validatePlan(context.basePlan, baseHistory.ids);
  failures.push(...basePlan.failures.map((failure) => `base plan: ${failure}`));
  const headPlan = validatePlan(context.headPlan, baseHistory.ids);
  failures.push(...headPlan.failures.map((failure) => `head plan: ${failure}`));
  if (typeof context.basePlan === 'string' && typeof context.headPlan === 'string') {
    failures.push(...validateQueueEdit({
      title: context.title, changedFiles: context.changedFiles ?? [], basePlan: context.basePlan, headPlan: context.headPlan,
    }));
  }
  const own = title && basePlan.tasks.find((task) => task.number === title.number);
  if (own && own.type !== title.type) failures.push(`${title.id}: queued type ${own.type} must match PR type`);
  if (release && title) validateReleaseTask(context, title, failures);
  return { failures, nextId: title?.id ?? 'plan-only' };
}
