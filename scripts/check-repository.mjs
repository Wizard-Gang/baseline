#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRepositoryAt } from './repository-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = validateRepositoryAt(root);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Repository phase, workflows, permissions, security, and provider policy passed.');
}
