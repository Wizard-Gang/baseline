import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const expectedHashes = {
  "AGENTS.md": "b28d13780f990fc5dad1072d6d4b4dd041ce4f56422a7558c16ca82a34b925dc",
  "CONTRIBUTING.md": "d8233a501f2339979a77fc495ea06d53a30f917bc921cf71370a73685e665210",
  // The empty template, hashed with its highest-ID marker normalized by templateText().
  "implementation_plan.md": "d61d1c570db3eac5fbc27f79a403561621dcabf0eefb9456e4b9070313c33732",
};

const markerPattern = /^\*\*Highest ID ever used:\*\* ([A-Z][A-Z0-9]*)-(\d{3,})\.$/gm;
const taskTitlePattern = /^\[([A-Z][A-Z0-9]*)-(\d{3,})\] \[[A-Z][A-Z0-9-]*\] \S/;
const planTitlePattern = /^\[PLAN\] \S/;

export function openTasks(source) {
  return [...source.matchAll(/^### ([A-Z][A-Z0-9]*)-(\d{3,}) — \[([A-Z][A-Z0-9-]*)\] (\S.*)$/gm)]
    .map((match) => ({
      id: `${match[1]}-${match[2]}`, prefix: match[1], number: Number(match[2]), type: match[3], title: match[4],
    }));
}

export function firstOpenTask(source) {
  return openTasks(source)[0] ?? null;
}

// The plan records the highest ID ever used, in history or any plan, so a removed queued ID stays retired.
export function highestUsedId(source) {
  const markers = [...source.matchAll(markerPattern)];
  if (markers.length !== 1) return null;
  return { id: `${markers[0][1]}-${markers[0][2]}`, prefix: markers[0][1], number: Number(markers[0][2]) };
}

export function templateText(source) {
  return source.replace(markerPattern, "**Highest ID ever used:** <ID>.");
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function validateQueue(source) {
  const failures = [];
  if (!source.startsWith("# Implementation plan\n")) failures.push("plan must retain the queue header");
  if (!source.includes("\n## Open tasks\n")) failures.push("plan must retain the open-task section");
  const highest = highestUsedId(source);
  if (!highest) failures.push("plan must record exactly one **Highest ID ever used:** marker");
  const tasks = openTasks(source);
  if (tasks.length === 0 && sha256(templateText(source)) !== expectedHashes["implementation_plan.md"]) {
    failures.push("empty queue must use the permanent shared template");
  }
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) failures.push("queued IDs must be unique");
  for (const task of tasks) {
    if (highest && task.prefix !== highest.prefix) failures.push(`${task.id}: one repository ID namespace per queue`);
    else if (highest && task.number > highest.number) failures.push(`${task.id}: is above the recorded ${highest.id}`);
  }
  return failures;
}

// A task or [PLAN] PR's queue edit. Any PR may add, edit, reorder or remove queued tasks; only new IDs are constrained.
export function validateQueueEdit({ title, changedFiles, basePlan, headPlan }) {
  const failures = [
    ...validateQueue(basePlan).map((failure) => `base plan: ${failure}`),
    ...validateQueue(headPlan).map((failure) => `head plan: ${failure}`),
  ];
  const base = highestUsedId(basePlan);
  const head = highestUsedId(headPlan);
  if (!base || !head) return failures;
  if (head.number < base.number) failures.push(`highest ID ever used must never fall below ${base.id}`);
  const queued = new Set(openTasks(basePlan).map((task) => task.id));
  for (const task of openTasks(headPlan)) {
    if (!queued.has(task.id) && task.number <= base.number) {
      failures.push(`${task.id}: a new task takes an ID above ${base.id}; IDs are never recycled`);
    }
  }
  if (planTitlePattern.test(title)) {
    if (changedFiles.length !== 1 || changedFiles[0] !== "implementation_plan.md") {
      failures.push("a [PLAN] PR changes only implementation_plan.md");
    }
    return failures;
  }
  const match = taskTitlePattern.exec(title);
  if (!match) return [...failures, "title must be [PLAN] Imperative summary or [ID] [TYPE] Imperative summary"];
  const id = `${match[1]}-${match[2]}`;
  if (match[1] !== base.prefix) failures.push(`${id}: one repository ID namespace per queue`);
  else if (!queued.has(id) && Number(match[2]) <= base.number) {
    failures.push(`${id} is neither queued nor a new ID above ${base.id}`);
  }
  if (Number(match[2]) > head.number) failures.push(`${id}: the head plan must raise its highest ID ever used`);
  if (openTasks(headPlan).some((task) => task.id === id)) failures.push(`${id}: a delivery removes its own task`);
  return failures;
}

export function validatePortfolioContract() {
  for (const file of ["AGENTS.md", "CONTRIBUTING.md", "implementation_plan.md"]) {
    assert.ok(existsSync(path.join(root, file)), `${file} must remain tracked`);
  }
  assert.equal(readdirSync(root).includes("IMPLEMENTATION_PLAN.md"), false, "uppercase plan must be retired");
  for (const file of ["AGENTS.md", "CONTRIBUTING.md"]) {
    assert.equal(sha256(readFileSync(path.join(root, file))), expectedHashes[file],
      `${file} differs from the portfolio contract`);
  }
  const plan = readFileSync(path.join(root, "implementation_plan.md"), "utf8");
  assert.deepEqual(validateQueue(plan), []);
  return openTasks(plan).length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = validatePortfolioContract();
  console.log(`Portfolio contract valid; ${count} open implementation task(s).`);
}
