#!/usr/bin/env node
// Prints the vendor.lock.json of platform/ (the default) or contract/ for a baseline commit: every file under
// that directory at that commit with its SHA-256. A consumer vendors the directory from the same commit and
// commits this output inside it.
//   npm run vendor:lock -- <commit> [platform|contract]
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildLock, formatLock, VENDORED_DIRECTORIES } from '../platform/conformance/vendor.mjs';

const git = (args, cwd, encoding = 'utf8') => {
  const result = spawnSync('git', args, { cwd, encoding, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${String(result.stderr ?? '').trim()}`);
  return result.stdout;
};

/**
 * @param {string} revision a baseline commit
 * @param {string} [cwd] the baseline checkout
 * @param {string} [directory] the vendored directory, platform or contract
 * @returns {string} the formatted lock
 */
export function lockForCommit(revision, cwd = process.cwd(), directory = 'platform') {
  if (!/^[0-9A-Za-z][0-9A-Za-z._/-]*$/.test(revision ?? '')) throw new Error('give the baseline commit to lock');
  if (!VENDORED_DIRECTORIES.includes(directory)) throw new Error(`the vendored directory must be ${VENDORED_DIRECTORIES.join(' or ')}`);
  const commit = git(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], cwd).trim();
  const entries = git(['ls-tree', '-r', '-z', '--full-tree', commit, '--', `${directory}/`], cwd).split('\0').filter(Boolean);
  const files = new Map();
  for (const entry of entries) {
    const [meta, path] = entry.split('\t');
    const [mode, type, object] = meta.split(' ');
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error(`${path} is not a regular file at ${commit}`);
    files.set(path.slice(`${directory}/`.length), git(['cat-file', 'blob', object], cwd, 'buffer'));
  }
  if (!files.size) throw new Error(`${commit} has no ${directory}/ files`);
  return formatLock(buildLock(commit, files));
}

// realpath on both sides: a symlinked checkout path must still run, never silently exit 0.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.length > 4) throw new Error('usage: vendor-lock.mjs <commit> [platform|contract]');
    process.stdout.write(lockForCommit(process.argv[2], process.cwd(), process.argv[3] ?? 'platform'));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
