#!/usr/bin/env node
// Prints platform/vendor.lock.json for a baseline commit: every file under platform/ at that commit with its
// SHA-256. A consumer vendors platform/ from the same commit and commits this output next to it.
//   npm run vendor:lock -- <commit>
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildLock, formatLock } from '../platform/conformance/vendor.mjs';

const git = (args, cwd, encoding = 'utf8') => {
  const result = spawnSync('git', args, { cwd, encoding, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${String(result.stderr ?? '').trim()}`);
  return result.stdout;
};

/**
 * @param {string} revision a baseline commit
 * @param {string} [cwd] the baseline checkout
 * @returns {string} the formatted lock
 */
export function lockForCommit(revision, cwd = process.cwd()) {
  if (!/^[0-9A-Za-z][0-9A-Za-z._/-]*$/.test(revision ?? '')) throw new Error('give the baseline commit to lock');
  const commit = git(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], cwd).trim();
  const entries = git(['ls-tree', '-r', '-z', '--full-tree', commit, '--', 'platform/'], cwd).split('\0').filter(Boolean);
  const files = new Map();
  for (const entry of entries) {
    const [meta, path] = entry.split('\t');
    const [mode, type, object] = meta.split(' ');
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error(`${path} is not a regular file at ${commit}`);
    files.set(path.slice('platform/'.length), git(['cat-file', 'blob', object], cwd, 'buffer'));
  }
  if (!files.size) throw new Error(`${commit} has no platform/ files`);
  return formatLock(buildLock(commit, files));
}

// realpath on both sides: a symlinked checkout path must still run, never silently exit 0.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.stdout.write(lockForCommit(process.argv[2]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
