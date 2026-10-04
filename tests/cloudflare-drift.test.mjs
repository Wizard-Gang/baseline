import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadCloudflareDesiredState } from '../scripts/cloudflare-desired-state.mjs';
import { compareCloudflareState, expectedCloudflareState, hasDrift } from '../scripts/cloudflare-drift.mjs';
import { normalizeLifecycle } from '../scripts/cloudflare-live-state.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desired = loadCloudflareDesiredState(root);
const expected = expectedCloudflareState(desired);

function driftFor(mutate) {
  const want = structuredClone(expected);
  const got = structuredClone(expected);
  mutate(want, got);
  return compareCloudflareState(want, got);
}

test('the desired state compared with itself has no drift', () => {
  const drift = compareCloudflareState(expected, structuredClone(expected));
  assert.deepEqual(drift, { missing: [], unexpected: [], mismatched: [] });
  assert.equal(hasDrift(drift), false);
});

test('the expected state is derived from config/cloudflare.json', () => {
  assert.deepEqual(expected.workers, ['wizardgang', 'demo', 'sharktank', 'hexframe']);
  assert.deepEqual(expected.domains['www.wizardgang.ai'], { worker: 'wizardgang', enabled: true });
  assert.deepEqual(expected.durableObjects, ['demo:DemoCoordinator', 'sharktank:Room']);
  assert.deepEqual(expected.crons, ['demo: */5 * * * *']);
  assert.equal(expected.secrets.length, 7);
  assert.deepEqual(expected.secretsStoreSecrets, ['default_secrets_store:WG_OPS_TOKEN', 'default_secrets_store:WG_SESSION_KEY']);
  assert.deepEqual(expected.lifecycle.wizardgang, [
    'abort incomplete multipart uploads (all objects) after 1d',
    'expire demo/uploads/ after 1d',
  ]);
});

// Name sets: a missing name, an unexpected name, and a changed name (reported as one missing plus one unexpected).
const SETS = [
  ['workers', 'Worker', 'wizardgang', 'wizardgang-portfolio'],
  ['d1', 'D1 database', 'wizardgang', 'demo-blob'],
  ['r2', 'R2 bucket', 'wizardgang', 'wizardgang-demo-r2'],
  ['kv', 'KV namespace', 'wg-edge-cache', 'wg-gateway-status-dev'],
  ['durableObjects', 'Durable Object', 'sharktank:Room', 'wizardgangprod:Room'],
  ['crons', 'cron', 'demo: */5 * * * *', 'demo: */10 * * * *'],
  ['secrets', 'Worker secret', 'demo:DEMO_SESSION_SECRET', 'hexframe:ADMIN_PASSWORD'],
  ['secretsStores', 'Secrets Store', 'default_secrets_store', 'other_store'],
  ['secretsStoreSecrets', 'Secrets Store secret', 'default_secrets_store:WG_OPS_TOKEN', 'default_secrets_store:OPS_TOKEN'],
];

for (const [key, noun, declared, stray] of SETS) {
  test(`${noun}: missing, unexpected and changed entries are drift`, () => {
    const ensure = (state) => { if (!state[key].includes(declared)) state[key].push(declared); };
    let drift = driftFor((want, got) => { ensure(want); got[key] = got[key].filter((entry) => entry !== declared); });
    assert.deepEqual(drift, { missing: [`${noun} ${declared}`], unexpected: [], mismatched: [] });
    drift = driftFor((want, got) => { got[key].push(stray); });
    assert.deepEqual(drift, { missing: [], unexpected: [`${noun} ${stray}`], mismatched: [] });
    drift = driftFor((want, got) => { ensure(want); ensure(got); got[key] = got[key].map((entry) => (entry === declared ? stray : entry)); });
    assert.deepEqual(drift, { missing: [`${noun} ${declared}`], unexpected: [`${noun} ${stray}`], mismatched: [] });
  });
}

test('custom domains: missing, unexpected, wrong Worker and disabled hosts are drift', () => {
  assert.deepEqual(driftFor((want, got) => { delete got.domains['www.wizardgang.ai']; }).missing,
    ['custom domain www.wizardgang.ai → wizardgang']);
  assert.deepEqual(driftFor((want, got) => { got.domains['staging.wizardgang.ai'] = { worker: 'wizardgang', enabled: true }; }).unexpected,
    ['custom domain staging.wizardgang.ai → wizardgang']);
  assert.deepEqual(driftFor((want, got) => { got.domains['wizardgang.ai'].worker = 'wizardgang-portfolio'; }).mismatched,
    ['custom domain wizardgang.ai: expected Worker wizardgang, got wizardgang-portfolio']);
  assert.deepEqual(driftFor((want, got) => { got.domains['hexframe.wizardgang.ai'].enabled = false; }).mismatched,
    ['custom domain hexframe.wizardgang.ai: expected enabled, got disabled']);
});

test('per-Worker settings: every setting mismatch is drift', () => {
  const mismatched = (mutate) => driftFor((want, got) => mutate(got.settings.hexframe)).mismatched;
  assert.deepEqual(mismatched((settings) => { settings.compatibilityDate = '2026-06-28'; }),
    ['Worker hexframe compatibility date: expected 2026-08-31, got 2026-06-28']);
  assert.deepEqual(mismatched((settings) => { settings.compatibilityFlags = ['assets_navigation_has_no_effect']; }),
    ['Worker hexframe compatibility flags: expected nodejs_compat, got assets_navigation_has_no_effect']);
  assert.deepEqual(mismatched((settings) => { settings.compatibilityFlags = []; }),
    ['Worker hexframe compatibility flags: expected nodejs_compat, got (none)']);
  assert.deepEqual(mismatched((settings) => { settings.observability = false; }), ['Worker hexframe observability: expected on, got off']);
  assert.deepEqual(mismatched((settings) => { settings.workersDev = true; }), ['Worker hexframe workers.dev: expected off, got on']);
  assert.deepEqual(mismatched((settings) => { settings.previewUrls = true; }), ['Worker hexframe preview URLs: expected off, got on']);
});

test('per-Worker settings are compared only for Workers that exist', () => {
  const drift = driftFor((want, got) => { got.workers = got.workers.filter((name) => name !== 'demo'); delete got.settings.demo; });
  assert.deepEqual(drift, { missing: ['Worker demo'], unexpected: [], mismatched: [] });
});

test('R2 lifecycle rules: missing, unexpected and changed rules are drift', () => {
  const lifecycle = (mutate) => driftFor((want, got) => mutate(got.lifecycle.wizardgang));
  assert.deepEqual(lifecycle((rules) => { rules.pop(); }).missing, ['R2 lifecycle rule wizardgang: expire demo/uploads/ after 1d']);
  assert.deepEqual(lifecycle((rules) => { rules.push('expire sharktank/ after 30d'); }).unexpected,
    ['R2 lifecycle rule wizardgang: expire sharktank/ after 30d']);
  const changed = lifecycle((rules) => { rules[0] = 'abort incomplete multipart uploads (all objects) after 7d'; });
  assert.deepEqual([changed.missing, changed.unexpected], [
    ['R2 lifecycle rule wizardgang: abort incomplete multipart uploads (all objects) after 1d'],
    ['R2 lifecycle rule wizardgang: abort incomplete multipart uploads (all objects) after 7d'],
  ]);
  const absent = driftFor((want, got) => { got.r2 = []; delete got.lifecycle.wizardgang; });
  assert.deepEqual(absent, { missing: ['R2 bucket wizardgang'], unexpected: [], mismatched: [] });
});

test('live lifecycle rules normalize one line per transition', () => {
  assert.deepEqual(normalizeLifecycle([
    { id: 'default', enabled: true, conditions: {}, abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 604800 } } },
    { id: 'both', enabled: true, conditions: { prefix: 'demo/uploads/' },
      abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 86400 } },
      deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86400 } } },
    { id: 'off', enabled: false, conditions: { prefix: 'demo/' }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 3600 } } },
    { id: 'dated', enabled: true, conditions: { prefix: 'demo/' }, deleteObjectsTransition: { condition: { type: 'Date', date: '2027-01-01T00:00:00Z' } },
      storageClassTransitions: [{ condition: { type: 'Age', maxAge: 2592000 }, storageClass: 'InfrequentAccess' }] },
  ]), [
    'abort incomplete multipart uploads (all objects) after 7d',
    'abort incomplete multipart uploads demo/uploads/ after 1d',
    'expire demo/uploads/ after 1d',
    'expire demo/ after 3600s [disabled]',
    'expire demo/ on 2027-01-01T00:00:00Z',
    'transition demo/ to InfrequentAccess after 30d',
  ]);
  assert.deepEqual(normalizeLifecycle(undefined), []);
});
