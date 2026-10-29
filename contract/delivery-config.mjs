// Each repository's committed delivery identity, the only per-repository input to the shared contract/ scripts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DELIVERY_CONFIG = 'config/delivery.json';
export const DELIVERY_KEYS = Object.freeze([
  'name', 'repository', 'idPrefix', 'lastDirectTask', 'planFields', 'releaseWorkflow', 'migrationPins',
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateDeliveryConfig(config) {
  if (!isObject(config)) return [`${DELIVERY_CONFIG} must be an object`];
  const failures = [];
  const keys = Object.keys(config);
  if (keys.length !== DELIVERY_KEYS.length || !DELIVERY_KEYS.every((key) => keys.includes(key))) {
    failures.push(`${DELIVERY_CONFIG} must declare exactly ${DELIVERY_KEYS.join(', ')}`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(config.name ?? '')) failures.push('name must be the lower-case repository name');
  if (!/^Wizard-Gang\/[A-Za-z0-9._-]+$/.test(config.repository ?? '')) failures.push('repository must be Wizard-Gang/<name>');
  if (!/^[A-Z][A-Z0-9]*$/.test(config.idPrefix ?? '') || ['PLAN', 'RELEASE'].includes(config.idPrefix)) {
    failures.push('idPrefix must be an upper-case task ID prefix other than PLAN or RELEASE');
  }
  if (!Number.isSafeInteger(config.lastDirectTask) || config.lastDirectTask < 0) {
    failures.push('lastDirectTask must be the last task number merged straight into main, or 0');
  }
  const fields = config.planFields;
  if (!Array.isArray(fields) || !fields.length || new Set(fields).size !== fields.length
      || fields.some((field) => typeof field !== 'string' || !/^[A-Z][A-Za-z-]*$/.test(field))) {
    failures.push('planFields must list unique capitalized task-block field names');
  }
  for (const key of ['releaseWorkflow', 'migrationPins']) {
    if (typeof config[key] !== 'boolean') failures.push(`${key} must be true or false`);
  }
  return failures;
}

export function readDeliveryConfig(root) {
  const config = JSON.parse(readFileSync(join(root, DELIVERY_CONFIG), 'utf8'));
  const failures = validateDeliveryConfig(config);
  if (failures.length) throw new Error(`${DELIVERY_CONFIG}: ${failures.join('; ')}`);
  return Object.freeze({ ...config, planFields: Object.freeze([...config.planFields]) });
}

// The checkout that carries this contract/ directory.
export const DELIVERY = readDeliveryConfig(fileURLToPath(new URL('../', import.meta.url)));
