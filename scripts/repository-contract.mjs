import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadCloudflareDesiredState, validateCloudflareDesiredState } from './cloudflare-desired-state.mjs';
import { validateMigrationsAt } from './migration-contract.mjs';
import { DEPLOY_WORKFLOW, validateDeployWorkflow } from './deploy-workflow-contract.mjs';
import { block, keys } from './workflow-yaml.mjs';

function requireMatch(failures, name, source, pattern) {
  if (!pattern.test(source ?? '')) failures.push(name);
}

function sameSet(actual, expected) {
  return actual.length === expected.length && expected.every((entry) => actual.includes(entry));
}

// Top-level paths that would make baseline a product repository. The platform grant never unlocks them.
export const FORBIDDEN_APPLICATION_PATHS = Object.freeze(['src', 'app', 'apps', 'game', 'pages', 'public', 'workers', 'functions']);
export const PLATFORM_GRANT = Object.freeze({ path: 'platform/', purpose: 'shared edge code only' });

export function hasPlatformGrant(phase) {
  const grant = phase?.platform;
  return grant !== null && typeof grant === 'object' && !Array.isArray(grant)
    && sameSet(Object.keys(grant), Object.keys(PLATFORM_GRANT))
    && grant.path === PLATFORM_GRANT.path && grant.purpose === PLATFORM_GRANT.purpose;
}

export function validatePhase(phase) {
  const failures = [];
  if (phase?.phase !== 'contract' || phase?.applicationDevelopment !== false) {
    failures.push('application development must remain disabled during contract proof');
  }
  if (!sameSet(Object.keys(phase ?? {}), ['phase', 'applicationDevelopment', 'platform'])) {
    failures.push('phase must declare exactly phase, applicationDevelopment and the platform grant');
  }
  if (!hasPlatformGrant(phase)) {
    failures.push('phase platform grant must be exactly platform/ for shared edge code only');
  }
  return failures;
}

// `present` maps each existing top-level path to whether it is a directory.
export function validateRepositoryPaths(present, phase) {
  const failures = [];
  for (const path of FORBIDDEN_APPLICATION_PATHS) {
    if (present.has(path)) failures.push(`application path exists before contract proof: ${path}`);
  }
  if (present.has('platform')) {
    if (!hasPlatformGrant(phase)) failures.push('platform/ exists without the config/phase.json platform grant');
    else if (present.get('platform') !== true) failures.push('platform/ must be a directory');
  }
  return failures;
}

// Owner-run Cloudflare token commands and the scripts they must run.
export const TOKEN_SCRIPTS = Object.freeze({
  'discover:cloudflare-token-targets': 'discover-cloudflare-token-targets.mjs',
  'rotate:cloudflare-token': 'rotate-cloudflare-token.mjs',
});

// Baseline's workflows: its own CI and release path, plus the reusable deploy that only consumers call.
export const WORKFLOWS = Object.freeze(['ci.yml', 'deploy-worker.yml', 'release-cutter.yml', 'release.yml']);

export function validateRepositoryContract({ ci, release, cutter, deploy, pkg, lock, phase, provider }) {
  const failures = [];
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? '')) failures.push('package.json owns a semantic version');
  if (pkg.private !== true) failures.push('source-only seed must be private to npm publication');
  if (pkg.packageManager !== 'npm@12.1.0' || pkg.engines?.node !== '26.x' || pkg.engines?.npm !== '12.x') {
    failures.push('packageManager and engines must match the shared Node 26/npm 12 baseline');
  }
  if (lock?.version !== pkg.version || lock?.packages?.['']?.version !== pkg.version) {
    failures.push('package-lock version must match package.json');
  }
  failures.push(...validatePhase(phase));
  if (pkg.scripts?.['audit:dependencies'] !== 'npm audit --audit-level=high') {
    failures.push('dependency advisory gate must fail on high-severity advisories');
  }
  for (const name of ['check', 'check:change', 'check:release', 'check:patch', 'check:workflow-shell', 'test:plan-queue', 'test:github-settings', 'verify:github-settings', 'apply:github-settings', 'verify:cloudflare', 'vendor:lock', ...Object.keys(TOKEN_SCRIPTS)]) {
    if (!pkg.scripts?.[name]) failures.push(`missing package script ${name}`);
  }
  if (pkg.scripts?.['vendor:lock'] !== 'node scripts/vendor-lock.mjs') {
    failures.push('vendor:lock must print the platform/ lock with scripts/vendor-lock.mjs');
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

  const ciEvents = keys(block(ci, 'on'), 2);
  if (!sameSet(ciEvents, ['pull_request', 'push'])) failures.push('CI must trigger only on PR and main push');
  requireMatch(failures, 'CI must rerun when PR title or body is edited', block(ci, 'pull_request', 2), /types: \[[^\]]*edited[^\]]*\]/);
  requireMatch(failures, 'CI push target must be main', block(ci, 'push', 2), /^    branches: \[main\]$/m);
  if (block(ci, 'permissions')?.trim() !== 'contents: read') failures.push('CI default token must be read-only');
  requireMatch(failures, 'CI must cancel only in-progress PR runs', block(ci, 'concurrency'), /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  const ciJobs = keys(block(ci, 'jobs'), 2);
  if (!sameSet(ciJobs, ['verify', 'change-id', 'security'])) failures.push('CI must expose verify, change-id, security required jobs');
  for (const job of ciJobs) {
    const contents = block(ci, job, 2);
    requireMatch(failures, `${job} must check out the exact PR head`, contents,
      /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
    if (block(contents, 'permissions', 4)) failures.push(`${job} must not broaden token permissions`);
  }
  requireMatch(failures, 'verify must run the complete local contract', block(ci, 'verify', 2), /run: npm run check/);
  requireMatch(failures, 'verify must check the committed PR patch', block(ci, 'verify', 2), /run: npm run check:patch/);
  requireMatch(failures, 'change-id must validate exact PR identity', block(ci, 'change-id', 2), /run: npm run check:change/);
  requireMatch(failures, 'security must run the dependency advisory gate', block(ci, 'security', 2), /run: npm run audit:dependencies/);

  const releaseEvents = keys(block(release, 'on'), 2);
  if (!sameSet(releaseEvents, ['push', 'workflow_dispatch'])) failures.push('Release must trigger from tag pushes or explicit cutter dispatch');
  requireMatch(failures, 'Release must use tag push trigger', block(release, 'push', 2), /tags: \['v\*'\]/);
  requireMatch(failures, 'Release dispatch must bind accepted commit', block(release, 'workflow_dispatch', 2), /expected_sha:/);
  requireMatch(failures, 'Release must preserve tag ref for attestation', release, /\[\[ "\$GITHUB_REF" == "refs\/tags\/\$GITHUB_REF_NAME" \]\]/);
  requireMatch(failures, 'Release must compare dispatched commit', release, /\[ "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA" \]/);
  if (block(release, 'permissions')?.trim() !== 'contents: read') failures.push('Release default token must be read-only');
  requireMatch(failures, 'Release must serialize by tag', block(release, 'concurrency'), /group: release-\$\{\{ github\.ref \}\}/);
  requireMatch(failures, 'Release must not cancel publication', block(release, 'concurrency'), /cancel-in-progress: false/);
  const releaseJobs = keys(block(release, 'jobs'), 2);
  if (!sameSet(releaseJobs, ['reproduce', 'publish'])) failures.push('Release must reproduce before publication');
  const reproduce = block(release, 'reproduce', 2);
  const publish = block(release, 'publish', 2);
  requireMatch(failures, 'Release verification must test source and advisories', reproduce,
    /run: npm run check[\s\S]*run: npm run audit:dependencies/);
  requireMatch(failures, 'Release verification must check annotated tag', reproduce, /check:release -- identity --tag/);
  requireMatch(failures, 'Release archive must omit gzip timestamp', reproduce, /git archive[^\n]+\| gzip -n/);
  requireMatch(failures, 'Publication must depend on reproduction', publish, /needs: reproduce/);
  for (const permission of ['contents: write', 'id-token: write', 'attestations: write']) {
    if (!block(publish, 'permissions', 4)?.includes(permission)) failures.push(`publication requires scoped ${permission}`);
  }
  requireMatch(failures, 'Publication must compare clean-job archive digests', publish, /EXPECTED_SHA256[\s\S]*test "\$actual" = "\$EXPECTED_SHA256"/);
  requireMatch(failures, 'Publication must generate a GitHub attestation', publish, /uses: actions\/attest@[0-9a-f]{40}/);
  requireMatch(failures, 'Publication must verify artifact attestation', publish, /check-release\.mjs attestation/);
  requireMatch(failures, 'Publication must reconcile release state', publish, /scripts\/publish-release\.mjs/);

  const cutterEvents = keys(block(cutter, 'on'), 2);
  if (!sameSet(cutterEvents, ['workflow_run'])) failures.push('Release Cutter must follow CI workflow_run only');
  requireMatch(failures, 'Release Cutter must require successful main push CI', cutter,
    /workflow_run\.conclusion == 'success'[\s\S]*workflow_run\.event == 'push'[\s\S]*workflow_run\.head_branch == 'main'/);
  requireMatch(failures, 'Release Cutter must check exact current main', cutter, /git rev-parse origin\/main/);
  requireMatch(failures, 'Release Cutter must create an annotated exact-head tag', cutter, /git tag -a "\$tag" "\$VALIDATED_SHA"/);
  requireMatch(failures, 'Release Cutter must leave older same-version tags untouched', cutter, /\[ "\$release_sha" != "\$VALIDATED_SHA" \]/);
  requireMatch(failures, 'Release Cutter must dispatch the exact tag and commit', cutter,
    /gh workflow run release\.yml --ref "\$RELEASE_TAG" -f expected_sha="\$EXPECTED_SHA"/);
  for (const permission of ['contents: write', 'actions: write']) {
    if (!block(cutter, 'permissions')?.includes(permission)) failures.push(`Release Cutter requires scoped ${permission}`);
  }

  const allUses = [...`${ci}\n${release}\n${cutter}`.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  if (!allUses.length || allUses.some((use) => !/^actions\/[a-z0-9-]+@[0-9a-f]{40}$/.test(use))) {
    failures.push('every action must be GitHub-owned and pinned to a full commit SHA');
  }
  for (const match of `${ci}\n${release}\n${cutter}`.matchAll(/\bnpm run ([\w:-]+)/g)) {
    if (!pkg.scripts?.[match[1]]) failures.push(`workflow references missing package script ${match[1]}`);
  }
  const requiredChecks = provider?.requiredStatusChecks;
  if (!sameSet(requiredChecks ?? [], ciJobs)) failures.push('provider required checks must match CI job names');
  if (provider?.repository !== 'Wizard-Gang/baseline' || provider?.defaultBranch !== 'main'
      || provider?.mergeMethods?.mergeCommit !== false || provider?.mergeMethods?.squash !== true
      || provider?.mergeMethods?.rebase !== false || provider?.deleteBranchOnMerge !== true
      || provider?.allowAutoMerge !== true) {
    failures.push('provider must enforce the committed squash-only baseline');
  }
  const main = provider?.rulesets?.find((rule) => rule.target === 'branch');
  const tags = provider?.rulesets?.find((rule) => rule.target === 'tag');
  if (main?.enforcement !== 'active' || main?.requireBranchUpToDate !== true
      || main?.bypassActors?.length !== 0 || !sameSet(main?.rules ?? [], ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks'])) {
    failures.push('main ruleset must protect current main with no bypass actors');
  }
  if (tags?.enforcement !== 'active' || tags?.bypassActors?.length !== 0
      || !sameSet(tags?.include ?? [], ['refs/tags/v*']) || !sameSet(tags?.rules ?? [], ['deletion', 'update'])) {
    failures.push('release tag ruleset must make v* tags immutable');
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
    'scripts/check-workflow-shell.mjs', 'tests/workflow-shell.test.mjs',
    '.github/workflows/release-cutter.yml', 'config/phase.json',
    'config/cloudflare.json', 'scripts/cloudflare-desired-state.mjs', 'tests/cloudflare-desired-state.test.mjs',
    'scripts/verify-cloudflare.mjs', 'scripts/cloudflare-drift.mjs', 'scripts/cloudflare-live-state.mjs',
    'tests/cloudflare-drift.test.mjs', 'tests/verify-cloudflare.test.mjs', 'tests/fixtures/cloudflare-2026-10-03.json',
    ...['README.md', 'index.mjs', 'index.d.ts', 'auth.mjs', 'http.mjs', 'log.mjs', 'storage.mjs', 'workers.mjs']
      .map((file) => `platform/wg-edge/${file}`),
    'tests/wg-edge-http.test.mjs', 'tests/wg-edge-admin.test.mjs', 'tests/wg-edge-storage.test.mjs',
    'tests/wg-edge-shape.test.mjs', 'tests/fixtures/wg-edge-fakes.mjs',
    'platform/migrations/0001_universal.sql', 'platform/migrations/pins.json', 'scripts/migration-contract.mjs',
    'tests/migrations.test.mjs', 'tests/migration-contract.test.mjs',
    'platform/wrangler.template.jsonc', 'scripts/vendor-lock.mjs',
    ...['README.md', 'index.d.ts', 'cli.mjs', 'desired.mjs', 'jsonc.mjs', 'template.mjs', 'vendor.mjs', 'wrangler.mjs']
      .map((file) => `platform/conformance/${file}`),
    'tests/wrangler-conformance.test.mjs', 'tests/vendoring.test.mjs', 'tests/fixtures/wrangler-hexframe-f95b735.jsonc',
    DEPLOY_WORKFLOW, 'scripts/deploy-workflow-contract.mjs', 'scripts/workflow-yaml.mjs', 'tests/deploy-workflow-contract.test.mjs',
    'platform/deploy/README.md', 'platform/deploy/index.d.ts', 'platform/deploy/verify.mjs', 'tests/deploy-verify.test.mjs',
    'scripts/cloudflare-token-targets.mjs', ...Object.values(TOKEN_SCRIPTS).map((file) => `scripts/${file}`),
    'tests/cloudflare-token-discovery.test.mjs', 'tests/cloudflare-token-rotation.test.mjs', 'tests/fixtures/fake-gh.mjs',
  ];
  const failures = [];
  for (const path of required) {
    if (!existsSync(join(root, path)) || !readFileSync(join(root, path), 'utf8').trim()) {
      failures.push(`missing or empty repository authority: ${path}`);
    }
  }
  if (failures.length) return failures;
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const present = new Map([...FORBIDDEN_APPLICATION_PATHS, 'platform']
    .filter((path) => existsSync(join(root, path)))
    .map((path) => [path, statSync(join(root, path)).isDirectory()]));
  failures.push(...validateRepositoryPaths(present, JSON.parse(read('config/phase.json'))));
  // Baseline is the vendoring source; only a consumer's vendored copy carries a lock.
  if (existsSync(join(root, 'platform/vendor.lock.json'))) failures.push('baseline platform/ is the vendoring source and must not carry vendor.lock.json');
  const workflows = readdirSync(join(root, '.github/workflows')).sort();
  if (workflows.join() !== WORKFLOWS.join()) failures.push(`workflows must be exactly ${WORKFLOWS.join(', ')}`);
  for (const config of ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml']) {
    if (existsSync(join(root, config))) failures.push(`baseline never deploys and must not carry ${config}`);
  }
  if (failures.length) return failures;
  failures.push(...validateCloudflareDesiredState(loadCloudflareDesiredState(root))
    .map((failure) => `config/cloudflare.json: ${failure}`));
  failures.push(...validateMigrationsAt(root).map((failure) => `migrations: ${failure}`));
  return [...failures, ...validateRepositoryContract({
    ci: read('.github/workflows/ci.yml'),
    release: read('.github/workflows/release.yml'),
    cutter: read('.github/workflows/release-cutter.yml'),
    deploy: read(DEPLOY_WORKFLOW),
    pkg: JSON.parse(read('package.json')),
    lock: JSON.parse(read('package-lock.json')),
    phase: JSON.parse(read('config/phase.json')),
    provider: JSON.parse(read('config/github-repository-settings.json')),
  })];
}
