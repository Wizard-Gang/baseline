// Renders platform/wrangler.template.jsonc into a starting wrangler config for one declared Worker. A Worker with
// Durable Objects gets bindings and a first migration for its declared classes; one with crons gets its triggers.
// A Worker that already has Durable Object history keeps its own migrations; the checker only needs the net classes.
import { DESIRED } from './desired.mjs';
import { parseJsonc } from './jsonc.mjs';

const STORE_ID = /^[0-9a-f]{32}$/;

/**
 * @param {string} template the template source
 * @param {string} label a declared Worker label
 * @param {{ secretsStoreId: string }} ids the default_secrets_store ID, supplied at render time and never by baseline
 * @returns {Record<string, unknown>} the rendered config
 */
export function renderWranglerTemplate(template, label, { secretsStoreId }, shared = DESIRED) {
  if (!Object.hasOwn(shared.workers, label)) throw new Error(`${JSON.stringify(label)} is not a declared Worker`);
  if (!STORE_ID.test(secretsStoreId ?? '')) throw new Error('secretsStoreId must be a 32-character hex Secrets Store ID');
  const worker = shared.workers[label];
  const config = /** @type {Record<string, unknown>} */ (parseJsonc(template
    .replaceAll('__WG_APP__', label)
    .replaceAll('__WG_HOST__', worker.host)
    .replaceAll('__SECRETS_STORE_ID__', secretsStoreId)));
  if (/__[A-Z_]+__/.test(JSON.stringify(config))) throw new Error('the template has an unknown placeholder');
  if (worker.durableObjects.length) {
    config.durable_objects = { bindings: worker.durableObjects.map((name) => ({ name, class_name: name })) };
    config.migrations = [{ tag: 'v1', new_sqlite_classes: [...worker.durableObjects] }];
  }
  if (worker.crons.length) config.triggers = { crons: [...worker.crons] };
  return config;
}
