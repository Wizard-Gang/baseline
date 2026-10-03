// The vendoring pin. A consumer copies baseline platform/ verbatim and commits platform/vendor.lock.json, which
// names the baseline commit it came from and the SHA-256 of every file. Any edit, missing file or unpinned file
// fails, so the vendored shell, schema and checker can only change by re-vendoring from baseline.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_FILE = 'vendor.lock.json';
export const SOURCE = 'Wizard-Gang/baseline';
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** @param {string | Uint8Array} content */
export const sha256 = (content) => createHash('sha256').update(content).digest('hex');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPath = (path) => path.split('/').every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..');

/**
 * @param {string} commit the full baseline commit the files were read from
 * @param {Map<string, string | Uint8Array>} files contents keyed by path relative to platform/
 */
export function buildLock(commit, files) {
  if (!COMMIT.test(commit)) throw new Error('the lock commit must be a full 40-character SHA');
  const paths = [...files.keys()].filter((path) => path !== LOCK_FILE).sort();
  for (const path of paths) if (!isPath(path)) throw new Error(`unsafe vendored path: ${path}`);
  return { schemaVersion: 1, source: SOURCE, commit, files: Object.fromEntries(paths.map((path) => [path, sha256(files.get(path))])) };
}

/** @param {ReturnType<typeof buildLock>} lock */
export const formatLock = (lock) => `${JSON.stringify(lock, null, 2)}\n`;

/** @param {unknown} lock @returns {string[]} */
export function validateLockShape(lock) {
  if (!isObject(lock)) return [`${LOCK_FILE} must be a JSON object`];
  const failures = [];
  const keys = Object.keys(lock).sort().join(',');
  if (keys !== 'commit,files,schemaVersion,source') failures.push(`${LOCK_FILE} must hold exactly schemaVersion, source, commit and files`);
  if (lock.schemaVersion !== 1) failures.push(`${LOCK_FILE} schemaVersion must be 1`);
  if (lock.source !== SOURCE) failures.push(`${LOCK_FILE} source must be ${SOURCE}`);
  if (!COMMIT.test(lock.commit ?? '')) failures.push(`${LOCK_FILE} commit must be a full 40-character baseline SHA`);
  if (!isObject(lock.files) || !Object.keys(lock.files).length) return [...failures, `${LOCK_FILE} files must pin at least one file`];
  for (const [path, digest] of Object.entries(lock.files)) {
    if (!isPath(path) || path === LOCK_FILE) failures.push(`${LOCK_FILE} pins an unsafe path: ${path}`);
    if (typeof digest !== 'string' || !DIGEST.test(digest)) failures.push(`${LOCK_FILE} pin for ${path} must be a SHA-256 hex digest`);
  }
  return failures;
}

/**
 * Compare the files present under platform/ with the lock.
 * @param {unknown} lock @param {Map<string, string | Uint8Array>} files @param {string[]} [unsafe] symlinks and other non-files
 */
export function compareVendored(lock, files, unsafe = []) {
  const failures = validateLockShape(lock);
  if (failures.length) return failures;
  const pins = /** @type {Record<string, string>} */ (/** @type {any} */ (lock).files);
  for (const path of unsafe) failures.push(`platform/${path} is not a regular file`);
  for (const [path, content] of files) {
    if (path === LOCK_FILE) continue;
    if (!Object.hasOwn(pins, path)) failures.push(`platform/${path} is not pinned; vendored platform/ must match baseline exactly`);
    else if (pins[path] !== sha256(content)) failures.push(`platform/${path} differs from baseline ${/** @type {any} */ (lock).commit}; never edit vendored files`);
  }
  for (const path of Object.keys(pins)) {
    if (!files.has(path)) failures.push(`platform/${path} is pinned but missing`);
  }
  return failures;
}

/** @param {string} directory @param {string} [prefix] */
function walk(directory, prefix = '', files = new Map(), unsafe = []) {
  for (const name of readdirSync(directory).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(join(directory, name));
    if (stat.isDirectory()) walk(join(directory, name), path, files, unsafe);
    else if (stat.isFile()) files.set(path, readFileSync(join(directory, name)));
    else unsafe.push(path);
  }
  return { files, unsafe };
}

/**
 * Verify a consumer checkout's vendored platform/ against its lock.
 * @param {string} root the consumer repository root
 */
export function verifyVendored(root) {
  const directory = join(root, 'platform');
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return ['platform/ must be a vendored directory'];
  if (!existsSync(join(directory, LOCK_FILE))) return [`platform/${LOCK_FILE} is missing; print it with baseline npm run vendor:lock -- <commit>`];
  let lock;
  try {
    lock = JSON.parse(readFileSync(join(directory, LOCK_FILE), 'utf8'));
  } catch {
    return [`platform/${LOCK_FILE} is not valid JSON`];
  }
  const { files, unsafe } = walk(directory);
  return compareVendored(lock, files, unsafe);
}
