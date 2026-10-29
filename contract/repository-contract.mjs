// The shared delivery rules every repository's check:repository enforces: package pins, the delivery commands, the
// CI, release and cutter workflows, and the provider rulesets. Each repository adds its own rules beside them.
import { block, keys } from './workflow-yaml.mjs';
import { DELIVERY } from './delivery-config.mjs';

export function requireMatch(failures, name, source, pattern) {
  if (!pattern.test(source ?? '')) failures.push(name);
}

export function sameSet(actual, expected) {
  return actual.length === expected.length && expected.every((entry) => actual.includes(entry));
}

// Shared delivery commands and the contract/ scripts they must run, so consumers vendor the same files.
export function contractScripts(delivery = DELIVERY) {
  return Object.freeze({
    'check:change': 'check-change.mjs',
    'check:patch': 'check-patch.mjs',
    'check:workflow-shell': 'check-workflow-shell.mjs',
    'test:plan-queue': 'check-portfolio-contract.mjs',
    'verify:github-settings': 'verify-github-repository-settings.mjs',
    'apply:github-settings': 'apply-github-repository-settings.mjs',
    ...(delivery.releaseWorkflow ? { 'check:release': 'check-release.mjs' } : {}),
  });
}
export const CONTRACT_SCRIPTS = contractScripts();

export const DELIVERY_SCRIPTS = Object.freeze([
  'check', 'check:gate', 'check:change', 'check:patch', 'check:workflow-shell', 'test:plan-queue',
  'test:github-settings', 'verify:github-settings', 'apply:github-settings',
]);

// Release and cutter are checked only where config/delivery.json declares a release workflow.
export function validateDeliveryContract({ ci, release, cutter, pkg, lock, provider }, delivery = DELIVERY) {
  const failures = [];
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? '')) failures.push('package.json owns a semantic version');
  if (pkg.private !== true) failures.push('source-only seed must be private to npm publication');
  if (pkg.packageManager !== 'npm@12.1.0' || pkg.engines?.node !== '26.x' || pkg.engines?.npm !== '12.x') {
    failures.push('packageManager and engines must match the shared Node 26/npm 12 baseline');
  }
  if (lock?.version !== pkg.version || lock?.packages?.['']?.version !== pkg.version) {
    failures.push('package-lock version must match package.json');
  }
  if (pkg.scripts?.['audit:dependencies'] !== 'npm audit --audit-level=high') {
    failures.push('dependency advisory gate must fail on high-severity advisories');
  }
  for (const name of [...DELIVERY_SCRIPTS, ...(delivery.releaseWorkflow ? ['check:release'] : [])]) {
    if (!pkg.scripts?.[name]) failures.push(`missing package script ${name}`);
  }
  for (const [name, file] of Object.entries(contractScripts(delivery))) {
    if (pkg.scripts?.[name] !== `node contract/${file}`) failures.push(`${name} must run contract/${file}`);
  }

  // Agents run no tests, so the fast gate must not either; verify runs the full suite.
  if (/node --test|npm (?:run )?test|npm run check(?:\s|$|&)/.test(pkg.scripts?.['check:gate'] ?? '')) {
    failures.push('check:gate runs only the non-test checks');
  }
  const ciEvents = keys(block(ci, 'on'), 2);
  if (!sameSet(ciEvents, ['pull_request', 'push', 'workflow_dispatch'])) {
    failures.push('CI must trigger only on PR, main push and an exact-head dispatch');
  }
  requireMatch(failures, 'CI must rerun when PR title or body is edited', block(ci, 'pull_request', 2), /types: \[[^\]]*edited[^\]]*\]/);
  requireMatch(failures, 'CI PR targets must be main and release branches', block(ci, 'pull_request', 2), /^    branches: \[main, 'release\/\*\*'\]$/m);
  requireMatch(failures, 'CI push target must be main', block(ci, 'push', 2), /^    branches: \[main\]$/m);
  if (block(ci, 'permissions')?.trim() !== 'contents: read') failures.push('CI default token must be read-only');
  requireMatch(failures, 'CI must cancel only in-progress PR runs', block(ci, 'concurrency'), /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  const ciJobs = keys(block(ci, 'jobs'), 2);
  if (!sameSet(ciJobs, ['verify', 'gate', 'change-id', 'security'])) failures.push('CI must expose verify, gate, change-id, security required jobs');
  for (const job of ciJobs) {
    const contents = block(ci, job, 2);
    requireMatch(failures, `${job} must check out the exact PR head`, contents,
      /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
    if (block(contents, 'permissions', 4)) failures.push(`${job} must not broaden token permissions`);
  }
  // A task or [PLAN] PR into release/* runs gate; the release PR into main, main pushes and dispatches run verify.
  const fullSuite = /^    if: github\.event_name != 'pull_request' \|\| github\.base_ref == 'main'$/m;
  requireMatch(failures, 'verify must skip only task PRs into release branches', block(ci, 'verify', 2), fullSuite);
  requireMatch(failures, 'security must skip only task PRs into release branches', block(ci, 'security', 2), fullSuite);
  requireMatch(failures, 'gate must run only on task PRs into release branches', block(ci, 'gate', 2),
    /^    if: github\.event_name == 'pull_request' && github\.base_ref != 'main'$/m);
  requireMatch(failures, 'change-id must run on every PR and main push', block(ci, 'change-id', 2),
    /^    if: github\.event_name != 'workflow_dispatch'$/m);
  requireMatch(failures, 'gate must run the non-test checks', block(ci, 'gate', 2), /run: npm run check:gate$/m);
  requireMatch(failures, 'gate must check the committed PR patch', block(ci, 'gate', 2), /run: npm run check:patch/);
  requireMatch(failures, 'verify must run the complete local contract', block(ci, 'verify', 2), /run: npm run check$/m);
  requireMatch(failures, 'verify must check the committed PR patch', block(ci, 'verify', 2), /run: npm run check:patch/);
  requireMatch(failures, 'change-id must validate exact PR identity', block(ci, 'change-id', 2), /run: npm run check:change/);
  requireMatch(failures, 'security must run the dependency advisory gate', block(ci, 'security', 2), /run: npm run audit:dependencies/);
  if (delivery.releaseWorkflow) {
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
    requireMatch(failures, 'Publication must reconcile release state', publish, /contract\/publish-release\.mjs/);

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
  }

  const workflows = [ci, ...(delivery.releaseWorkflow ? [release, cutter] : [])].join('\n');
  const allUses = [...workflows.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  if (!allUses.length || allUses.some((use) => !/^actions\/[a-z0-9-]+@[0-9a-f]{40}$/.test(use))) {
    failures.push('every action must be GitHub-owned and pinned to a full commit SHA');
  }
  for (const match of workflows.matchAll(/\bnpm run ([\w:-]+)/g)) {
    if (!pkg.scripts?.[match[1]]) failures.push(`workflow references missing package script ${match[1]}`);
  }
  const main = provider?.rulesets?.find((rule) => rule.name === 'main-protection');
  const releases = provider?.rulesets?.find((rule) => rule.name === 'release-branch-protection');
  const tags = provider?.rulesets?.find((rule) => rule.target === 'tag');
  const requiredChecks = [...new Set([...(main?.requiredStatusChecks ?? []), ...(releases?.requiredStatusChecks ?? [])])];
  if (!sameSet(requiredChecks, ciJobs)) failures.push('provider required checks must match CI job names');
  if (provider?.repository !== delivery.repository || provider?.defaultBranch !== 'main'
      || provider?.mergeMethods?.mergeCommit !== false || provider?.mergeMethods?.squash !== true
      || provider?.mergeMethods?.rebase !== true || provider?.deleteBranchOnMerge !== true
      || provider?.allowAutoMerge !== true || Object.hasOwn(provider ?? {}, 'requiredStatusChecks')) {
    failures.push('provider must allow only squash and rebase merges, with checks set per ruleset');
  }
  if (provider?.rulesets?.length !== 3 || main?.target !== 'branch' || releases?.target !== 'branch') {
    failures.push('provider must define exactly the main, release-branch and release-tag rulesets');
  }
  if (main?.enforcement !== 'active' || main?.requireBranchUpToDate !== true || main?.bypassActors?.length !== 0
      || !sameSet(main?.include ?? [], ['refs/heads/main']) || !sameSet(main?.allowedMergeMethods ?? [], ['rebase'])
      || !sameSet(main?.requiredStatusChecks ?? [], ['verify', 'change-id', 'security'])
      || !sameSet(main?.rules ?? [], ['deletion', 'non_fast_forward', 'pull_request', 'required_linear_history', 'required_status_checks'])) {
    failures.push('main ruleset must take only a rebase-merged release PR with green verify, change-id and security');
  }
  if (releases?.enforcement !== 'active' || releases?.requireBranchUpToDate !== true || releases?.bypassActors?.length !== 0
      || !sameSet(releases?.include ?? [], ['refs/heads/release/*']) || !sameSet(releases?.allowedMergeMethods ?? [], ['squash'])
      || !sameSet(releases?.requiredStatusChecks ?? [], ['gate', 'change-id'])
      || !sameSet(releases?.rules ?? [], ['non_fast_forward', 'pull_request', 'required_status_checks'])) {
    failures.push('release branch ruleset must take only squashed task PRs with green gate and change-id');
  }
  if (tags?.enforcement !== 'active' || tags?.bypassActors?.length !== 0
      || !sameSet(tags?.include ?? [], ['refs/tags/v*']) || !sameSet(tags?.rules ?? [], ['deletion', 'update'])) {
    failures.push('release tag ruleset must make v* tags immutable');
  }
  return failures;
}
