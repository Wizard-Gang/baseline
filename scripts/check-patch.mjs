#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const base = process.env.PATCH_BASE_SHA ?? '';
const head = process.env.PATCH_HEAD_SHA ?? '';
if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) {
  console.error('PATCH_BASE_SHA and PATCH_HEAD_SHA must be full commit SHAs.');
  process.exit(1);
}
for (const sha of [base, head]) {
  if (spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`]).status !== 0) {
    console.error(`Commit is missing from checkout: ${sha}`);
    process.exit(1);
  }
}
const checkedOut = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
if (checkedOut.status !== 0 || checkedOut.stdout.trim() !== head) {
  console.error('PATCH_HEAD_SHA must equal the checked-out exact head.');
  process.exit(1);
}
const result = spawnSync('git', ['diff', '--check', `${base}..${head}`], { encoding: 'utf8' });
if (result.status !== 0) {
  process.stderr.write((result.stdout ?? '') + (result.stderr ?? ''));
  process.exitCode = 1;
} else {
  console.log(`Committed patch whitespace passed: ${base}..${head}`);
}
