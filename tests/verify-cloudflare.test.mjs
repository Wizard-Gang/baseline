import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadCloudflareDesiredState } from '../scripts/cloudflare-desired-state.mjs';
import { cloudflareList } from '../scripts/cloudflare-live-state.mjs';
import { EXIT, runVerifyCloudflare } from '../scripts/verify-cloudflare.mjs';
import { ACCOUNT_ID, ENV, TOKEN, convergedResponses, fakeFetch, recordedResponses } from './fixtures/cloudflare-api.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desired = loadCloudflareDesiredState(root);

async function verify(responses, { env = ENV, at = root } = {}) {
  const calls = [];
  const out = [];
  const err = [];
  const code = await runVerifyCloudflare({
    env, root: at, fetchImpl: fakeFetch(responses, calls), log: (text) => out.push(text), error: (text) => err.push(text),
  });
  const printed = [...out, ...err].join('\n');
  assert.ok(!printed.includes(TOKEN), 'the token must never be printed');
  assert.ok(!printed.includes(ACCOUNT_ID), 'the account ID must never be printed');
  return { code, calls, out: out.join('\n'), err: err.join('\n') };
}

test('a converged account passes with GET calls only', async () => {
  const result = await verify(convergedResponses(desired));
  assert.equal(result.code, EXIT.converged);
  assert.equal(result.out, 'Cloudflare matches config/cloudflare.json.');
  assert.equal(result.err, '');
  assert.ok(result.calls.length > 0);
  assert.ok(result.calls.every((call) => call.method === 'GET' && call.authorization === `Bearer ${TOKEN}`));
});

test('the recorded 2026-10-03 account reports the expected drift', async () => {
  const result = await verify(recordedResponses('2026-10-03'));
  assert.equal(result.code, EXIT.drift);
  assert.ok(result.calls.every((call) => call.method === 'GET'));
  const lines = result.err.split('\n');
  assert.equal(lines[0], 'Cloudflare does not match config/cloudflare.json:');
  assert.deepEqual(lines.filter((line) => !line.startsWith('- ')).slice(1), ['Missing (18):', 'Unexpected (38):', 'Mismatched (4):']);
  for (const entry of [
    // The target Workers and shared resources do not exist yet; the live Workers carry the old names.
    'Worker wizardgang', 'Worker demo', 'Worker sharktank', 'D1 database wizardgang', 'R2 bucket wizardgang',
    'Durable Object demo:DemoCoordinator', 'Durable Object sharktank:Room', 'cron demo: */5 * * * *',
    'Worker secret demo:CLOUDFLARE_BILLING_TOKEN', 'Secrets Store secret default_secrets_store:WG_OPS_TOKEN',
    'Secrets Store secret default_secrets_store:WG_SESSION_KEY', 'custom domain www.wizardgang.ai → wizardgang',
  ]) assert.ok(lines.includes(`- ${entry}`), `missing ${entry}`);
  for (const entry of [
    // Phase 1 orphans, renamed Workers and their bindings, and dead admin secrets.
    'Worker wizardgang-portfolio-staging', 'Worker wizardgangprod', 'D1 database wizardgang-demo-data',
    'R2 bucket wizardgang-demo-r2-preview', 'KV namespace wg-gateway-status-dev', 'KV namespace wg-gateway-status-prod',
    'Durable Object wizardgangprod:Lobby', 'cron wizardgangprod: 17 3 * * *', 'Worker secret hexframe:ADMIN_PASSWORD',
    'Worker secret wizardgang-architecture-demo:DEMO_ADMIN_USER', 'Worker secret wizardgangprod:OPS_TOKEN',
  ]) assert.ok(lines.includes(`- ${entry}`), `unexpected ${entry}`);
  assert.deepEqual(lines.slice(-4), [
    '- custom domain wizardgang.ai: expected Worker wizardgang, got wizardgang-portfolio',
    '- custom domain demo.wizardgang.ai: expected Worker demo, got wizardgang-architecture-demo',
    '- custom domain sharktank.wizardgang.ai: expected Worker sharktank, got wizardgangprod',
    '- Worker hexframe compatibility date: expected 2026-08-31, got 2026-06-28',
  ]);
});

test('missing or malformed credentials fail closed before any request', async () => {
  for (const [env, pattern] of [
    [{}, /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set/],
    [{ CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID }, /CLOUDFLARE_API_TOKEN must be set/],
    [{ CLOUDFLARE_API_TOKEN: TOKEN }, /CLOUDFLARE_ACCOUNT_ID must be set/],
    [{ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: '../zones' }, /32-character lowercase hex account ID/],
  ]) {
    const result = await verify(convergedResponses(desired), { env });
    assert.equal(result.code, EXIT.credentials);
    assert.match(result.err, /^Missing Cloudflare credentials: /);
    assert.match(result.err, pattern);
    assert.equal(result.calls.length, 0);
  }
});

test('read-access failures are reported distinctly from other API failures', async () => {
  const failing = (status, body) => {
    const responses = convergedResponses(desired);
    responses['/d1/database'] = { status, body };
    return responses;
  };
  for (const [status, body] of [
    [403, { success: false, errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }] }],
    [401, { success: false, errors: [] }],
    [400, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }],
  ]) {
    const result = await verify(failing(status, body));
    assert.equal(result.code, EXIT.readAccess);
    assert.match(result.err, /^Cloudflare read access failed: Cloudflare GET \/accounts\/\{account\}\/d1\/database needs read access/);
  }
  const broken = await verify(failing(500, { success: false, errors: [{ code: 7000, message: 'Internal error' }] }));
  assert.equal(broken.code, EXIT.failure);
  assert.match(broken.err, /^Cloudflare read failed: Cloudflare GET \/accounts\/\{account\}\/d1\/database failed \(HTTP 500; 7000: Internal error\)/);
  const unreachable = await verify((path) => { if (path === '/d1/database') throw new Error(`socket closed for ${TOKEN}`); return convergedResponses(desired)[path]; });
  assert.equal(unreachable.code, EXIT.failure);
  assert.match(unreachable.err, /could not be reached: socket closed for \[redacted\]/);
});

test('an invalid committed authority fails before any request', async () => {
  const copy = mkdtempSync(join(tmpdir(), 'verify-cloudflare-'));
  try {
    cpSync(join(root, 'config'), join(copy, 'config'), { recursive: true });
    writeFileSync(join(copy, 'config/cloudflare.json'), JSON.stringify({ ...desired, kv: ['stray'] }));
    const result = await verify(convergedResponses(desired), { at: copy });
    assert.equal(result.code, EXIT.failure);
    assert.match(result.err, /config\/cloudflare.json is not a valid desired state; nothing was read:\n- kv: KV namespaces are not allowed/);
    assert.equal(result.calls.length, 0);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test('lists follow page and cursor pagination', async () => {
  const pages = {
    '/d1/database': { status: 200, body: { success: true, result: [{ name: 'a' }], result_info: { page: 1, per_page: 1, total_pages: 2 } } },
    '/d1/database?page=2&per_page=1': { status: 200, body: { success: true, result: [{ name: 'b' }], result_info: { page: 2, per_page: 1, total_pages: 2 } } },
    '/r2/buckets': { status: 200, body: { success: true, result: { buckets: [{ name: 'x' }] }, result_info: { cursor: 'next+1' } } },
    '/r2/buckets?cursor=next%2B1': { status: 200, body: { success: true, result: { buckets: [{ name: 'y' }] }, result_info: { cursor: '' } } },
  };
  const options = { token: TOKEN, accountId: ACCOUNT_ID, fetchImpl: fakeFetch(pages) };
  assert.deepEqual((await cloudflareList('/d1/database', options)).map((entry) => entry.name), ['a', 'b']);
  assert.deepEqual((await cloudflareList('/r2/buckets', options, (result) => result.buckets)).map((entry) => entry.name), ['x', 'y']);
});
