// The contract for .github/workflows/deploy-worker.yml, the reusable tag-to-production Worker deploy.
// Baseline only hosts it: the workflow runs solely when a consuming repository calls it.
import { literalRunBlocks } from './check-workflow-shell.mjs';
import { block, keys } from './workflow-yaml.mjs';

export const DEPLOY_WORKFLOW = '.github/workflows/deploy-worker.yml';
export const DEPLOY_INPUTS = Object.freeze(['worker', 'tag', 'expected_sha']);
export const DEPLOY_SECRETS = Object.freeze(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);
// The only wrangler deploy shape allowed: the caller's locked wrangler with resource provisioning off,
// so an unresolved binding fails instead of creating D1 wizardgang (or anything else) before Phase 3.
export const WRANGLER_DEPLOY = 'npx --no-install wrangler deploy --experimental-provision=false --experimental-auto-create=false';

const sameList = (actual, expected) => actual.length === expected.length && expected.every((entry) => actual.includes(entry));

/** Each `run:` command in source order, with literal blocks dedented and backslash continuations joined. */
export function runCommands(source) {
  return [...source.matchAll(/^[ \t]*(?:-[ \t]+)?run:[ \t]*(.*)$/gm)]
    .map((match) => (/^\|\s*$/.test(match[1]) ? literalRunBlocks(source.slice(match.index))[0] : match[1]))
    .map((command) => command.replace(/\\\n\s*/g, ''));
}

/** True when each pattern first matches after the previous one. */
function inOrder(source, patterns) {
  let from = 0;
  for (const pattern of patterns) {
    const found = source.slice(from).search(pattern);
    if (found < 0) return false;
    from += found + 1;
  }
  return true;
}

/**
 * @param {string | undefined} source the deploy-worker.yml text
 * @returns {string[]} failures
 */
export function validateDeployWorkflow(source) {
  if (!source?.trim()) return [`missing ${DEPLOY_WORKFLOW}`];
  const failures = [];
  const fail = (message) => failures.push(`deploy-worker: ${message}`);

  // Call-only: no push, PR, tag, schedule or dispatch trigger can run it inside baseline.
  const on = block(source, 'on');
  if (!sameList(keys(on, 2), ['workflow_call'])) fail('must trigger only on workflow_call');
  const call = block(on ?? '', 'workflow_call', 2);
  if (!sameList(keys(call, 4), ['inputs'])) fail('workflow_call must declare only inputs, never secrets or outputs');
  const inputs = block(call ?? '', 'inputs', 4);
  if (!sameList(keys(inputs, 6), DEPLOY_INPUTS)) fail(`inputs must be exactly ${DEPLOY_INPUTS.join(', ')}`);
  for (const name of DEPLOY_INPUTS) {
    const input = block(inputs ?? '', name, 6) ?? '';
    if (!/^ {8}required: true$/m.test(input) || !/^ {8}type: string$/m.test(input)) fail(`input ${name} must be a required string`);
  }
  if (/secrets:\s*inherit/.test(source)) fail('must never inherit caller secrets');

  // Least privilege: a read-only token everywhere, serialized per Worker and never cancelled mid-deploy.
  if (block(source, 'permissions')?.trim() !== 'contents: read') fail('default token must be contents: read');
  const concurrency = block(source, 'concurrency') ?? '';
  if (!/group: deploy-worker-\$\{\{ inputs\.worker \}\}/.test(concurrency) || !/cancel-in-progress: false/.test(concurrency)) {
    fail('must serialize per Worker without cancelling a deploy');
  }
  const jobs = block(source, 'jobs') ?? '';
  if (!sameList(keys(jobs, 2), ['verify', 'deploy'])) fail('jobs must be exactly verify and deploy');
  const verify = block(jobs, 'verify', 2) ?? '';
  const deploy = block(jobs, 'deploy', 2) ?? '';
  for (const [name, job] of [['verify', verify], ['deploy', deploy]]) {
    if (block(job, 'permissions', 4) !== null) fail(`${name} must not broaden token permissions`);
    if (!/ref: refs\/tags\/\$\{\{ inputs\.tag \}\}/.test(job)) fail(`${name} must check out the caller's tag`);
  }

  // Pinned, GitHub-owned actions only; no nested reusable or local workflow.
  const uses = [...source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  if (!uses.length || uses.some((use) => !/^actions\/[a-z0-9-]+@[0-9a-f]{40}$/.test(use))) {
    fail('every action must be GitHub-owned and pinned to a full commit SHA');
  }
  if (/^[ \t]*(?:-[ \t]+)?run:[ \t]*(?:[|>][^\s]|>)/m.test(source)) fail('run commands must be one line or a plain | block');
  if (runCommands(source).some((command) => command.includes('${{'))) fail('run commands must read inputs through env, never ${{ }}');

  // Environment binding: only the deploy job sees secrets, only the two Cloudflare ones, from the caller's production environment.
  if (!/^ {4}environment:\n {6}name: production$/m.test(deploy)) fail('deploy must bind the caller\'s production environment');
  if (/^ {4}environment:/m.test(verify)) fail('verify must not bind an environment');
  if (!/^ {4}needs: verify$/m.test(deploy)) fail('deploy must need verify');
  const secretNames = (text) => [...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  if (secretNames(verify).length) fail('verify must not read secrets');
  if (secretNames(source).some((name) => !DEPLOY_SECRETS.includes(name)) || !sameList([...new Set(secretNames(deploy))], DEPLOY_SECRETS)) {
    fail(`deploy may read only ${DEPLOY_SECRETS.join(' and ')}`);
  }

  // Tag identity, source checks and conformance, in order, before the deploy job can start.
  if (!inOrder(verify, [
    /git cat-file -t "refs\/tags\/\$RELEASE_TAG"\)" = tag \]/,
    /git rev-parse "refs\/tags\/\$RELEASE_TAG\^\{commit\}"\)" = "\$EXPECTED_SHA" \]/,
    /\[ "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA" \]/,
    /\[ "v\$version" = "\$RELEASE_TAG" \]/,
    /run: npm ci$/m,
    /run: npm run check$/m,
    /run: node platform\/conformance\/cli\.mjs pin$/m,
    /run: node platform\/conformance\/cli\.mjs wrangler --worker "\$WORKER"$/m,
  ])) fail('verify must bind the annotated tag to package.json and the commit, then run npm ci, npm run check, pin and wrangler conformance');

  // The deploy job rebinds the tag, deploys with provisioning off, then proves 100% traffic and the public identity.
  const deployCommands = runCommands(deploy).join('\n');
  const deploys = runCommands(source).flatMap((command) => command.split('\n')).filter((line) => /wrangler\s+deploy\b/.test(line));
  if (deploys.length !== 1 || !deploys[0].includes(WRANGLER_DEPLOY)) fail(`the only wrangler deploy must be: ${WRANGLER_DEPLOY}`);
  if (/wrangler\s+(?:d1|r2|kv|queues|secret|secrets-store|versions|rollback|delete|triggers)\b/.test(source)) {
    fail('must not run any other mutating wrangler command');
  }
  if (!inOrder(deployCommands, [
    /\[ "\$\(git rev-parse "refs\/tags\/\$RELEASE_TAG\^\{commit\}"\)" = "\$EXPECTED_SHA" \]/,
    /\[ "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA" \]/,
    /^npm ci$/m,
    /wrangler deploy /,
    /wrangler deployments status --name "\$WORKER" --json/,
    /node platform\/deploy\/verify\.mjs traffic --worker "\$WORKER"/,
    /node platform\/deploy\/verify\.mjs version --worker "\$WORKER" --version "\$\{RELEASE_TAG#v\}" --commit "\$EXPECTED_SHA"/,
  ])) fail('deploy must rebind the tag, deploy, confirm 100% traffic and then poll /version.json for the tag identity');
  return failures;
}
