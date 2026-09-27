import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const expectedHashes = {
  "AGENTS.md": "60d4d958f268a79fd43fcc3ffa83f60e5a2fc788fa7993db91c27cdebba1de49",
  "CONTRIBUTING.md": "f28a453e08e8090cd9afca364165c37e9c428e357aa1e2f35354ac620efcb633",
  "implementation_plan.md": "59cdf5f8622ee928364b5647474b3a83f502c949bde9562d0a53a33291b090d0",
};

export function openTasks(source) {
  return [...source.matchAll(/^### ([A-Z][A-Z0-9]*-\d{3,}) — \[([A-Z][A-Z0-9-]*)\] (\S.*)$/gm)]
    .map((match) => ({ id: match[1], type: match[2], title: match[3] }));
}

export function firstOpenTask(source) {
  return openTasks(source)[0] ?? null;
}

function hash(file) {
  return createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex");
}

export function validatePortfolioContract() {
  for (const file of ["AGENTS.md", "CONTRIBUTING.md", "implementation_plan.md"]) {
    assert.ok(existsSync(path.join(root, file)), `${file} must remain tracked`);
  }
  assert.equal(readdirSync(root).includes("IMPLEMENTATION_PLAN.md"), false, "uppercase plan must be retired");
  for (const file of ["AGENTS.md", "CONTRIBUTING.md"]) {
    assert.equal(hash(file), expectedHashes[file], `${file} differs from the portfolio contract`);
  }
  const plan = readFileSync(path.join(root, "implementation_plan.md"), "utf8");
  const tasks = openTasks(plan);
  if (tasks.length === 0) {
    assert.equal(hash("implementation_plan.md"), expectedHashes["implementation_plan.md"],
      "empty queue must use the permanent shared template");
    assert.equal(firstOpenTask(plan), null, "empty queue must select no implementation task");
  } else {
    assert.ok(plan.startsWith("# Implementation plan\n"), "filled queue must retain the plan header");
    assert.ok(plan.includes("## Open tasks\n"), "filled queue must retain the open-task section");
    assert.equal(firstOpenTask(plan)?.id, tasks[0].id);
    const prefix = tasks[0].id.replace(/-\d+$/, "");
    let previous = -1;
    for (const task of tasks) {
      assert.ok(task.id.startsWith(`${prefix}-`), "one repository ID namespace per queue");
      const number = Number(task.id.split("-").at(-1));
      assert.ok(number > previous, "queued IDs must be unique and increasing");
      previous = number;
    }
  }
  return tasks.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(firstOpenTask("# Implementation plan\n\n## Open tasks\n\nNo tasks.\n"), null);
  assert.equal(firstOpenTask("### HF-148 — [OPS] First\n### HF-149 — [OPS] Second\n")?.id, "HF-148");
  assert.equal(firstOpenTask("HF-148 appears in prose, not a task heading.\n"), null);
  const count = validatePortfolioContract();
  console.log(`Portfolio contract valid; ${count} open implementation task(s).`);
}
