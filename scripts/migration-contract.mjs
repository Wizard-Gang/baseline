// The shared-database migration contract. Baseline is the only DDL owner for the `wizardgang` D1 database:
// SQL exists only as platform/migrations/NNNN_name.sql, numbered contiguously from 0001, and every migration
// is SHA-256 pinned in platform/migrations/pins.json in the commit that adds it. A merged migration is never
// edited, renamed or removed; a schema change is always the next number.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const MIGRATIONS_DIR = 'platform/migrations';
export const PINS_FILE = 'pins.json';
export const MIGRATION_NAME = /^(\d{4})_[a-z][a-z0-9_]*\.sql$/;
const SQL = /\.sql$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const SKIPPED = new Set(['.git', 'node_modules']);

/** @param {string | Uint8Array} content */
export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/** @param {unknown} pins */
function isPinMap(pins) {
  return pins !== null && typeof pins === 'object' && !Array.isArray(pins)
    && Object.values(pins).every((digest) => typeof digest === 'string' && DIGEST.test(digest));
}

/**
 * @param {{ sqlPaths: string[], entries: Map<string, boolean>, contents: Map<string, string | Uint8Array>, pins: unknown }} input
 *   `sqlPaths` are every repository-relative `.sql` path (any case); `entries` maps each name directly inside
 *   platform/migrations/ to whether it is a directory; `contents` holds each migration file; `pins` is pins.json.
 */
export function validateMigrations({ sqlPaths, entries, contents, pins }) {
  const failures = [];
  for (const path of sqlPaths) {
    const inside = path.startsWith(`${MIGRATIONS_DIR}/`) && !path.slice(MIGRATIONS_DIR.length + 1).includes('/');
    if (!inside) failures.push(`SQL may exist only directly under ${MIGRATIONS_DIR}/: ${path}`);
  }
  const migrations = [];
  for (const [name, isDirectory] of entries) {
    if (name === PINS_FILE && !isDirectory) continue;
    const match = MIGRATION_NAME.exec(name);
    if (!match || isDirectory) failures.push(`${MIGRATIONS_DIR}/${name} is not a NNNN_name.sql migration`);
    else migrations.push({ name, number: Number(match[1]) });
  }
  migrations.sort((left, right) => (left.name < right.name ? -1 : 1));
  if (!migrations.length) failures.push(`${MIGRATIONS_DIR}/ must start with 0001_universal.sql`);
  migrations.forEach(({ name, number }, index) => {
    if (number !== index + 1) failures.push(`${name} is out of sequence; the next migration number is ${String(index + 1).padStart(4, '0')}`);
  });
  if (migrations.length && migrations[0].name !== '0001_universal.sql') failures.push('the first migration must be 0001_universal.sql');

  if (!isPinMap(pins)) {
    failures.push(`${MIGRATIONS_DIR}/${PINS_FILE} must map each migration file name to its SHA-256 hex digest`);
    return failures;
  }
  const pinned = /** @type {Record<string, string>} */ (pins);
  for (const { name } of migrations) {
    const actual = sha256(contents.get(name) ?? '');
    if (!Object.hasOwn(pinned, name)) failures.push(`${name} is not hash-pinned in ${PINS_FILE} (sha256 ${actual})`);
    else if (pinned[name] !== actual) failures.push(`${name} differs from its pin; a merged migration is never edited, add the next number instead`);
  }
  for (const name of Object.keys(pinned)) {
    if (!migrations.some((migration) => migration.name === name)) failures.push(`${PINS_FILE} pins ${name}, which is missing; a merged migration is never removed or renamed`);
  }
  return failures;
}

/**
 * Pins already on the base commit must survive unchanged on the head, so editing a merged migration
 * cannot be hidden by re-pinning it.
 * @param {unknown} basePins @param {unknown} headPins
 */
export function validatePinHistory(basePins, headPins) {
  if (basePins === null || basePins === undefined) return [];
  if (!isPinMap(basePins)) return [`base ${PINS_FILE} is malformed`];
  if (!isPinMap(headPins)) return [`head ${PINS_FILE} is missing or malformed`];
  const base = /** @type {Record<string, string>} */ (basePins);
  const head = /** @type {Record<string, string>} */ (headPins);
  return Object.entries(base).filter(([name, digest]) => head[name] !== digest)
    .map(([name]) => `merged migration ${name} changed its pin or was removed`);
}

/** @param {string} root @param {string} [directory] @returns {string[]} */
function sqlPathsUnder(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sqlPathsUnder(root, path);
    return SQL.test(entry.name) ? [relative(root, path).split(sep).join('/')] : [];
  });
}

/** @param {string} root */
export function validateMigrationsAt(root) {
  const directory = join(root, MIGRATIONS_DIR);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [`${MIGRATIONS_DIR}/ must be a directory`];
  const names = readdirSync(directory);
  const entries = new Map(names.map((name) => [name, statSync(join(directory, name)).isDirectory()]));
  const contents = new Map(names.filter((name) => MIGRATION_NAME.test(name) && !entries.get(name))
    .map((name) => [name, readFileSync(join(directory, name))]));
  let pins = null;
  try {
    pins = JSON.parse(readFileSync(join(directory, PINS_FILE), 'utf8'));
  } catch {
    pins = null;
  }
  return validateMigrations({ sqlPaths: sqlPathsUnder(root), entries, contents, pins });
}
