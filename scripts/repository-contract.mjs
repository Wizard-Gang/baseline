import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadCloudflareDesiredState, validateCloudflareDesiredState } from './cloudflare-desired-state.mjs';
import { validateMigrationsAt } from './migration-contract.mjs';
import { validateSecretRegistryAt } from './secret-registry.mjs';
import { DEPLOY_WORKFLOW, validateDeployWorkflow } from './deploy-workflow-contract.mjs';
import { DELIVERY_CONFIG } from '../contract/delivery-config.mjs';
import { CONTRACT_SCRIPTS, sameSet, validateDeliveryContract } from '../contract/repository-contract.mjs';

export { CONTRACT_SCRIPTS };

// Top-level paths that would make baseline a product repository. The platform and contract grants never unlock them.
export const FORBIDDEN_APPLICATION_PATHS = Object.freeze(['src', 'app', 'apps', 'game', 'pages', 'public', 'workers', 'functions']);
export const PLATFORM_GRANT = Object.freeze({ path: 'platform/', purpose: 'shared edge code only' });
export const CONTRACT_GRANT = Object.freeze({ path: 'contract/', purpose: 'shared delivery tooling only' });
// Each vendored top-level directory and the exact grant that allows it.
export const GRANTS = Object.freeze({ platform: PLATFORM_GRANT, contract: CONTRACT_GRANT });

export function hasGrant(phase, name) {
  const expected = GRANTS[name];
  const grant = phase?.[name];
  return grant !== null && typeof grant === 'object' && !Array.isArray(grant)
    && sameSet(Object.keys(grant), Object.keys(expected))
    && grant.path === expected.path && grant.purpose === expected.purpose;
}

export function validatePhase(phase) {
  const failures = [];
  if (phase?.phase !== 'contract' || phase?.applicationDevelopment !== false) {
    failures.push('application development must remain disabled during contract proof');
  }
  if (!sameSet(Object.keys(phase ?? {}), ['phase', 'applicationDevelopment', ...Object.keys(GRANTS)])) {
    failures.push('phase must declare exactly phase, applicationDevelopment and the platform and contract grants');
  }
  for (const [name, grant] of Object.entries(GRANTS)) {
    if (!hasGrant(phase, name)) failures.push(`phase ${name} grant must be exactly ${grant.path} for ${grant.purpose}`);
  }
  return failures;
}

// `present` maps each existing top-level path to whether it is a directory.
export function validateRepositoryPaths(present, phase) {
  const failures = [];
  for (const path of FORBIDDEN_APPLICATION_PATHS) {
    if (present.has(path)) failures.push(`application path exists before contract proof: ${path}`);
  }
  for (const name of Object.keys(GRANTS)) {
    if (!present.has(name)) continue;
    if (!hasGrant(phase, name)) failures.push(`${name}/ exists without the config/phase.json ${name} grant`);
    else if (present.get(name) !== true) failures.push(`${name}/ must be a directory`);
  }
  return failures;
}

// Owner-run Cloudflare token commands and the scripts they must run.
export const TOKEN_SCRIPTS = Object.freeze({
  'discover:cloudflare-token-targets': 'discover-cloudflare-token-targets.mjs',
  'rotate:cloudflare-token': 'rotate-cloudflare-token.mjs',
});

// Baseline's own delivery identity, which the shared contract/ scripts read from config/delivery.json.
export const BASELINE_DELIVERY = Object.freeze({
  name: 'baseline',
  repository: 'Wizard-Gang/baseline',
  idPrefix: 'BASE',
  lastDirectTask: 43,
  planFields: ['Dependency', 'Why', 'Scope', 'Non-goals', 'Acceptance', 'Validation', 'Authorities'],
  releaseWorkflow: true,
  migrationPins: true,
});

// The contract/ modules the shared scripts import, beside the scripts the delivery commands run.
export const SHARED_MODULES = Object.freeze([
  'change-contract.mjs', 'delivery-config.mjs', 'github-repository-settings.mjs', 'publish-release.mjs',
  'release-contract.mjs', 'repository-contract.mjs',
]);

// Baseline's workflows: its own CI and release path, plus the reusable deploy that only consumers call.
export const WORKFLOWS = Object.freeze(['deploy-worker.yml', 'release-cutter.yml', 'release.yml', 'verify.yml']);

// The shared delivery rules (contract/repository-contract.mjs), then baseline's own: the contract phase, Cloudflare
// and token tooling, and the reusable deploy that baseline never runs itself.
export function validateRepositoryContract({ ci, release, cutter, deploy, pkg, lock, phase, provider }) {
  const failures = validateDeliveryContract({ ci, release, cutter, pkg, lock, provider });
  failures.push(...validatePhase(phase));
  for (const name of ['verify:cloudflare', 'vendor:lock', ...Object.keys(TOKEN_SCRIPTS)]) {
    if (!pkg.scripts?.[name]) failures.push(`missing package script ${name}`);
  }
  if (pkg.scripts?.['vendor:lock'] !== 'node scripts/vendor-lock.mjs') {
    failures.push('vendor:lock must print the platform/ and contract/ locks with scripts/vendor-lock.mjs');
  }
  if (pkg.scripts?.['verify:cloudflare'] !== 'node scripts/verify-cloudflare.mjs') {
    failures.push('verify:cloudflare must run the read-only scripts/verify-cloudflare.mjs');
  }
  // The live Cloudflare read is an owner-run command; credential-free check and every workflow stay offline.
  const cloudflareRead = /verify[:-]cloudflare|CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)/;
  if (cloudflareRead.test(pkg.scripts?.check ?? '')) failures.push('npm run check must not read Cloudflare');
  for (const [name, workflow] of [['CI', ci], ['Release', release], ['Release cutter', cutter]]) {
    if (cloudflareRead.test(workflow ?? '')) failures.push(`${name} workflow must not read Cloudflare`);
  }
  // Token discovery and rotation are owner-run with runtime gh credentials: no other package script, and so not
  // check, may reach them, and no workflow (the deploy included) may run them or write a GitHub secret.
  for (const [name, file] of Object.entries(TOKEN_SCRIPTS)) {
    if (pkg.scripts?.[name] !== `node scripts/${file}`) failures.push(`${name} must run scripts/${file}`);
  }
  const tokenTooling = /(?:discover|rotate)[:-]cloudflare-token|cloudflare-token-targets|secret\s+set/;
  for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
    if (!Object.hasOwn(TOKEN_SCRIPTS, name) && tokenTooling.test(script)) failures.push(`package script ${name} must not run Cloudflare token tooling`);
  }
  for (const [name, workflow] of [['CI', ci], ['Release', release], ['Release cutter', cutter], ['Deploy', deploy]]) {
    if (tokenTooling.test(workflow ?? '')) failures.push(`${name} workflow must not run Cloudflare token tooling`);
  }

  // Baseline never deploys: only consumers call deploy-worker.yml, and nothing of baseline's own runs wrangler or binds an environment.
  failures.push(...validateDeployWorkflow(deploy));
  for (const [name, workflow] of [['CI', ci], ['Release', release], ['Release cutter', cutter]]) {
    if (/deploy-worker|wrangler|^\s*environment:/m.test(workflow ?? '')) failures.push(`${name} workflow must never deploy`);
  }
  if (/wrangler|deploy-worker/.test(JSON.stringify(pkg.scripts ?? {}))) failures.push('package scripts must never deploy');
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (pkg[field]?.wrangler) failures.push('baseline must not depend on wrangler');
  }
  return failures;
}

export function validateRepositoryAt(root) {
  const required = [
    'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'LICENSE', 'SECURITY.md', 'docs/CHANGE-MANAGEMENT.md',
    'docs/RELEASE-MANAGEMENT.md', 'docs/OWNERSHIP.md', 'docs/CONTROL-MAP.md',
    '.node-version', 'package-lock.json', 'implementation_plan.md', '.github/pull_request_template.md',
    'tests/change-contract.test.mjs', 'tests/github-settings.test.mjs',
    'tests/release-contract.test.mjs', 'tests/repository-contract.test.mjs',
    ...Object.values(CONTRACT_SCRIPTS).map((file) => `contract/${file}`), 'contract/workflow-yaml.mjs',
    ...SHARED_MODULES.map((file) => `contract/${file}`), DELIVERY_CONFIG, 'tests/workflow-shell.test.mjs',
    '.github/workflows/release-cutter.yml', 'config/phase.json',
    'config/cloudflare.json', 'scripts/cloudflare-desired-state.mjs', 'tests/cloudflare-desired-state.test.mjs',
    'scripts/verify-cloudflare.mjs', 'scripts/cloudflare-drift.mjs', 'scripts/cloudflare-live-state.mjs',
    'tests/cloudflare-drift.test.mjs', 'tests/verify-cloudflare.test.mjs', 'tests/fixtures/cloudflare-2026-10-03.json',
    ...['README.md', 'index.mjs', 'index.d.ts', 'auth.mjs', 'http.mjs', 'log.mjs', 'storage.mjs', 'workers.mjs', 'keys.mjs', 'github.mjs']
      .map((file) => `platform/wg-edge/${file}`),
    'tests/wg-edge-http.test.mjs', 'tests/wg-edge-admin.test.mjs', 'tests/wg-edge-storage.test.mjs',
    'tests/wg-edge-keys.test.mjs', 'tests/wg-edge-github.test.mjs',
    'tests/wg-edge-shape.test.mjs', 'tests/fixtures/wg-edge-fakes.mjs',
    'platform/migrations/0001_universal.sql', 'platform/migrations/pins.json', 'scripts/migration-contract.mjs',
    'tests/migrations.test.mjs', 'tests/migration-contract.test.mjs',
    'platform/wrangler.template.jsonc', 'scripts/vendor-lock.mjs',
    ...['README.md', 'index.d.ts', 'cli.mjs', 'desired.mjs', 'jsonc.mjs', 'template.mjs', 'vendor.mjs', 'wrangler.mjs']
      .map((file) => `platform/conformance/${file}`),
    'tests/wrangler-conformance.test.mjs', 'tests/vendoring.test.mjs', 'tests/fixtures/wrangler-hexframe-f95b735.jsonc',
    DEPLOY_WORKFLOW, 'scripts/deploy-workflow-contract.mjs', 'tests/deploy-workflow-contract.test.mjs',
    'platform/deploy/README.md', 'platform/deploy/index.d.ts', 'platform/deploy/verify.mjs', 'tests/deploy-verify.test.mjs',
    'platform/deploy/evidence.mjs', 'tests/deploy-evidence.test.mjs',
    'scripts/cloudflare-token-targets.mjs', ...Object.values(TOKEN_SCRIPTS).map((file) => `scripts/${file}`),
    'tests/cloudflare-token-discovery.test.mjs', 'tests/cloudflare-token-rotation.test.mjs', 'tests/fixtures/fake-gh.mjs',
    'docs/CLOUDFLARE-RUNBOOK.md', 'tests/cloudflare-runbook.test.mjs', 'tests/fixtures/runbook.mjs',
    'docs/SECRETS-RUNBOOK.md', 'tests/secrets-runbook.test.mjs',
    'config/secrets.json', 'scripts/secret-registry.mjs', 'tests/secret-registry.test.mjs',
    ...['no-tests.mjs', 'no-tests.json', 'never.mjs', 'typecheck.mjs', 'typecheck.json', 'context-budget.mjs', 'context-budget.json', 'rulebook-cap.mjs', 'README.md']
      .map((file) => `agent/hooks/${file}`),
    'agent/RULEBOOK.md', 'agent/RULEBOOK-WHY.md', 'agent/claude/agents/lab-reviewer.md',
    'scripts/link-agent.mjs', 'tests/agent-tooling.test.mjs',
    'contract/check-portfolio-contract.mjs', 'tests/portfolio-contract.test.mjs', 'tests/fixtures/empty-plan.md',
  ];
  const failures = [];
  for (const path of required) {
    if (!existsSync(join(root, path)) || !readFileSync(join(root, path), 'utf8').trim()) {
      failures.push(`missing or empty repository authority: ${path}`);
    }
  }
  if (failures.length) return failures;
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const present = new Map([...FORBIDDEN_APPLICATION_PATHS, ...Object.keys(GRANTS)]
    .filter((path) => existsSync(join(root, path)))
    .map((path) => [path, statSync(join(root, path)).isDirectory()]));
  failures.push(...validateRepositoryPaths(present, JSON.parse(read('config/phase.json'))));
  if (!isDeepStrictEqual(JSON.parse(read(DELIVERY_CONFIG)), BASELINE_DELIVERY)) {
    failures.push(`${DELIVERY_CONFIG} must keep baseline's delivery identity`);
  }
  // Baseline is the vendoring source; only a consumer's vendored copy carries a lock.
  for (const name of Object.keys(GRANTS)) {
    if (existsSync(join(root, name, 'vendor.lock.json'))) failures.push(`baseline ${name}/ is the vendoring source and must not carry vendor.lock.json`);
  }
  const workflows = readdirSync(join(root, '.github/workflows')).sort();
  if (workflows.join() !== WORKFLOWS.join()) failures.push(`workflows must be exactly ${WORKFLOWS.join(', ')}`);
  for (const config of ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml']) {
    if (existsSync(join(root, config))) failures.push(`baseline never deploys and must not carry ${config}`);
  }
  if (failures.length) return failures;
  failures.push(...validateCloudflareDesiredState(loadCloudflareDesiredState(root))
    .map((failure) => `config/cloudflare.json: ${failure}`));
  failures.push(...validateMigrationsAt(root).map((failure) => `migrations: ${failure}`));
  failures.push(...validateSecretRegistryAt(root).map((failure) => `config/secrets.json: ${failure}`));
  return [...failures, ...validateRepositoryContract({
    ci: read('.github/workflows/verify.yml'),
    release: read('.github/workflows/release.yml'),
    cutter: read('.github/workflows/release-cutter.yml'),
    deploy: read(DEPLOY_WORKFLOW),
    pkg: JSON.parse(read('package.json')),
    lock: JSON.parse(read('package-lock.json')),
    phase: JSON.parse(read('config/phase.json')),
    provider: JSON.parse(read('config/github-repository-settings.json')),
  })];
}
