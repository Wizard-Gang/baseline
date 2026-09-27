import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function block(source, key, indent = 0) {
  const lines = source.split('\n');
  const marker = `${' '.repeat(indent)}${key}:`;
  const start = lines.findIndex((line) => line.trimEnd() === marker);
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const spaces = line.match(/^ */)[0].length;
    if (spaces <= indent) { end = index; break; }
  }
  return lines.slice(start + 1, end).join('\n');
}

function keys(source, indent) {
  if (source === null) return [];
  return [...source.matchAll(new RegExp(`^${' '.repeat(indent)}([A-Za-z0-9_-]+):(?:\\s|$)`, 'gm'))]
    .map((match) => match[1]);
}

function requireMatch(failures, name, source, pattern) {
  if (!pattern.test(source ?? '')) failures.push(name);
}

function sameSet(actual, expected) {
  return actual.length === expected.length && expected.every((entry) => actual.includes(entry));
}

export function validateRepositoryContract({ ci, release, pkg, lock, phase, provider }) {
  const failures = [];
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? '')) failures.push('package.json owns a semantic version');
  if (pkg.private !== true) failures.push('source-only seed must be private to npm publication');
  if (pkg.packageManager !== 'npm@12.1.0' || pkg.engines?.node !== '26.x' || pkg.engines?.npm !== '12.x') {
    failures.push('packageManager and engines must match the shared Node 26/npm 12 baseline');
  }
  if (lock?.version !== pkg.version || lock?.packages?.['']?.version !== pkg.version) {
    failures.push('package-lock version must match package.json');
  }
  if (phase?.phase !== 'contract' || phase?.applicationDevelopment !== false) {
    failures.push('application development must remain disabled during contract proof');
  }
  if (pkg.scripts?.['audit:dependencies'] !== 'npm audit --audit-level=high') {
    failures.push('dependency advisory gate must fail on high-severity advisories');
  }
  for (const name of ['check', 'check:change', 'check:release', 'check:patch', 'test:plan-queue', 'test:github-settings', 'verify:github-settings', 'apply:github-settings']) {
    if (!pkg.scripts?.[name]) failures.push(`missing package script ${name}`);
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
  if (!sameSet(releaseEvents, ['push'])) failures.push('Release must trigger only from tag pushes');
  requireMatch(failures, 'Release must use tag push trigger', block(release, 'push', 2), /tags: \['v\*'\]/);
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

  const allUses = [...`${ci}\n${release}`.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  if (!allUses.length || allUses.some((use) => !/^actions\/[a-z0-9-]+@[0-9a-f]{40}$/.test(use))) {
    failures.push('every action must be GitHub-owned and pinned to a full commit SHA');
  }
  for (const match of `${ci}\n${release}`.matchAll(/\bnpm run ([\w:-]+)/g)) {
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
  ];
  const failures = [];
  for (const path of required) {
    if (!existsSync(join(root, path)) || !readFileSync(join(root, path), 'utf8').trim()) {
      failures.push(`missing or empty repository authority: ${path}`);
    }
  }
  for (const path of ['src', 'app', 'apps', 'game', 'pages', 'public', 'workers', 'functions']) {
    if (existsSync(join(root, path))) failures.push(`application path exists before contract proof: ${path}`);
  }
  if (failures.length) return failures;
  const read = (path) => readFileSync(join(root, path), 'utf8');
  return validateRepositoryContract({
    ci: read('.github/workflows/ci.yml'),
    release: read('.github/workflows/release.yml'),
    pkg: JSON.parse(read('package.json')),
    lock: JSON.parse(read('package-lock.json')),
    phase: JSON.parse(read('config/phase.json')),
    provider: JSON.parse(read('config/github-repository-settings.json')),
  });
}
