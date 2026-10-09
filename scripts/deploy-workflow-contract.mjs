// The contract for .github/workflows/deploy-worker.yml, the reusable tag-to-production Worker deploy.
// Baseline only hosts it: the workflow runs solely when a consuming repository calls it.
import { literalRunBlocks } from './check-workflow-shell.mjs';
import { block, keys } from './workflow-yaml.mjs';

export const DEPLOY_WORKFLOW = '.github/workflows/deploy-worker.yml';
export const DEPLOY_INPUTS = Object.freeze(['worker', 'tag', 'expected_sha']);
// The one output: the compact deploy result the deploy job's observe step writes after every observation passed.
export const DEPLOY_OUTPUTS = Object.freeze(['result']);
// config/secrets.json registers the token as a production environment secret and the account ID as a variable.
export const DEPLOY_SECRETS = Object.freeze(['CLOUDFLARE_API_TOKEN']);
export const DEPLOY_VARIABLES = Object.freeze(['CLOUDFLARE_ACCOUNT_ID']);
// The only wrangler deploy shape allowed: the caller's locked wrangler with resource provisioning off,
// so an unresolved binding fails instead of creating D1 wizardgang (or anything else) before Phase 3.
export const WRANGLER_DEPLOY = 'npx --no-install wrangler deploy --experimental-provision=false --experimental-auto-create=false';
// The account ID is never committed, so the deploy hands it to the Worker as a plain-text var.
export const ACCOUNT_ID_VAR = '--var "CLOUDFLARE_ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID"';

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
  if (!sameList(keys(call, 4), ['inputs', 'outputs'])) fail('workflow_call must declare only inputs and outputs, never secrets');
  const inputs = block(call ?? '', 'inputs', 4);
  if (!sameList(keys(inputs, 6), DEPLOY_INPUTS)) fail(`inputs must be exactly ${DEPLOY_INPUTS.join(', ')}`);
  for (const name of DEPLOY_INPUTS) {
    const input = block(inputs ?? '', name, 6) ?? '';
    if (!/^ {8}required: true$/m.test(input) || !/^ {8}type: string$/m.test(input)) fail(`input ${name} must be a required string`);
  }
  const outputs = block(call ?? '', 'outputs', 4);
  if (!sameList(keys(outputs, 6), DEPLOY_OUTPUTS) || !/^ {8}value: \$\{\{ jobs\.deploy\.outputs\.result \}\}$/m.test(block(outputs ?? '', 'result', 6) ?? '')) {
    fail('the only output must be result, from jobs.deploy.outputs.result');
  }
  // Consumers call it with secrets: inherit; it must never pass those secrets on to another workflow.
  if (/secrets:\s*inherit/.test(source)) fail('must never pass secrets on to another workflow');

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
    if (!/ref: refs\/tags\/\$\{\{ inputs\.tag \}\}/.test(job)) fail(`${name} must check out the caller's tag`);
  }
  // Only verify reads the Actions API, for the caller's reproduction proof; deploy keeps the read-only default.
  const verifyPermissions = block(verify, 'permissions', 4);
  if (verifyPermissions === null || !sameList(verifyPermissions.split('\n').filter((line) => line.trim()).map((line) => line.trim()), ['actions: read', 'contents: read'])) {
    fail('verify permissions must be exactly actions: read and contents: read');
  }
  if (block(deploy, 'permissions', 4) !== null) fail('deploy must not broaden token permissions');
  if (/github\.token|secrets\.GITHUB_TOKEN/.test(deploy)) fail('deploy must not read the GitHub token');
  if (/continue-on-error/.test(source)) fail('no step or job may continue on error');
  if (/^ {6,}(?:- )?if:/m.test(jobs)) fail('no step may be skipped conditionally');

  // Pinned, GitHub-owned actions only; no nested reusable or local workflow.
  const uses = [...source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  if (!uses.length || uses.some((use) => !/^actions\/[a-z0-9-]+@[0-9a-f]{40}$/.test(use))) {
    fail('every action must be GitHub-owned and pinned to a full commit SHA');
  }
  if (/^[ \t]*(?:-[ \t]+)?run:[ \t]*(?:[|>][^\s]|>)/m.test(source)) fail('run commands must be one line or a plain | block');
  if (runCommands(source).some((command) => command.includes('${{'))) fail('run commands must read inputs through env, never ${{ }}');

  // Environment binding: only the deploy job reads the caller's production environment: the token secret and the account ID variable.
  if (!/^ {4}environment:\n {6}name: production$/m.test(deploy)) fail('deploy must bind the caller\'s production environment');
  if (/^ {4}environment:/m.test(verify)) fail('verify must not bind an environment');
  if (!/^ {4}needs: verify$/m.test(deploy)) fail('deploy must need verify');
  const referenced = (text, context) => [...text.matchAll(new RegExp(`${context}\\.([A-Za-z0-9_]+)`, 'g'))].map((match) => match[1]);
  if (referenced(verify, 'secrets').length) fail('verify must not read secrets');
  if (referenced(verify, 'vars').length) fail('verify must not read variables');
  if (referenced(source, 'secrets').some((name) => !DEPLOY_SECRETS.includes(name)) || !sameList([...new Set(referenced(deploy, 'secrets'))], DEPLOY_SECRETS)) {
    fail(`deploy may read only the secret ${DEPLOY_SECRETS.join(' and ')}`);
  }
  if (referenced(source, 'vars').some((name) => !DEPLOY_VARIABLES.includes(name)) || !sameList([...new Set(referenced(deploy, 'vars'))], DEPLOY_VARIABLES)) {
    fail(`deploy must read ${DEPLOY_VARIABLES.join(' and ')} as vars.${DEPLOY_VARIABLES[0]} and no other variable`);
  }
  if (/secrets\.CLOUDFLARE_ACCOUNT_ID\b/.test(source)) fail('CLOUDFLARE_ACCOUNT_ID is a registry variable; read vars.CLOUDFLARE_ACCOUNT_ID, never secrets.CLOUDFLARE_ACCOUNT_ID');

  // Tag identity, the caller's reproduction proof and conformance, in order, before the deploy job can start.
  if (!inOrder(verify, [
    /git cat-file -t "refs\/tags\/\$RELEASE_TAG"\)" = tag \]/,
    /git rev-parse "refs\/tags\/\$RELEASE_TAG\^\{commit\}"\)" = "\$EXPECTED_SHA" \]/,
    /\[ "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA" \]/,
    /\[ "v\$version" = "\$RELEASE_TAG" \]/,
    /git merge-base --is-ancestor "\$EXPECTED_SHA" refs\/remotes\/origin\/main/,
    /^ {10}GITHUB_TOKEN: \$\{\{ github\.token \}\}\n {8}run: node platform\/deploy\/verify\.mjs evidence --worker "\$WORKER" --tag "\$RELEASE_TAG" --commit "\$EXPECTED_SHA"$/m,
    /run: node platform\/conformance\/cli\.mjs pin$/m,
    /run: node platform\/conformance\/cli\.mjs wrangler --worker "\$WORKER"$/m,
  ])) fail('verify must bind the annotated tag to package.json and the commit on main, prove the caller\'s reproduction, then run pin and wrangler conformance');
  // The caller already reproduced the tag; verify never runs the suite, installs or builds again, and has no fallback.
  if (runCommands(verify).some((command) => /\bnpm\s+(?:ci|install|run|test|exec)\b|\bnpx\b|node_modules/.test(command))) {
    fail('verify must not install, build, test or run wrangler; the caller\'s reproduction job is the only acceptance run');
  }

  // The deploy job rebinds the tag, deploys with provisioning off, then proves 100% traffic and the public identity.
  const deployCommands = runCommands(deploy).join('\n');
  const deploys = runCommands(source).flatMap((command) => command.split('\n')).filter((line) => /wrangler\s+deploy\b/.test(line));
  if (deploys.length !== 1 || !deploys[0].includes(WRANGLER_DEPLOY)) fail(`the only wrangler deploy must be: ${WRANGLER_DEPLOY}`);
  if (deploys.length === 1 && !deploys[0].includes(ACCOUNT_ID_VAR)) fail(`the wrangler deploy must pass ${ACCOUNT_ID_VAR}`);
  if (/wrangler\s+(?:d1|r2|kv|queues|secret|secrets-store|versions|rollback|delete|triggers)\b/.test(source)) {
    fail('must not run any other mutating wrangler command');
  }
  if (!inOrder(deployCommands, [
    /\[ "\$\(git rev-parse "refs\/tags\/\$RELEASE_TAG\^\{commit\}"\)" = "\$EXPECTED_SHA" \]/,
    /\[ "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA" \]/,
    /^npm ci$/m,
    /^WG_VERSION="\$\{RELEASE_TAG#v\}" WG_COMMIT="\$EXPECTED_SHA" npm run build --if-present$/m,
    /wrangler deploy /,
    /wrangler deployments status --name "\$WORKER" --json/,
    /node platform\/deploy\/verify\.mjs traffic --worker "\$WORKER"/,
    /node platform\/deploy\/verify\.mjs observe --worker "\$WORKER" --tag "\$RELEASE_TAG" --commit "\$EXPECTED_SHA" --deploy-output "\$RUNNER_TEMP\/wrangler-deploy\.ndjson" --status "\$RUNNER_TEMP\/wrangler-deployment-status\.json" --result "\$RUNNER_TEMP\/deploy-result\.json"$/m,
    /^echo "result=\$\(cat "\$RUNNER_TEMP\/deploy-result\.json"\)" >> "\$GITHUB_OUTPUT"$/m,
  ])) fail('deploy must rebind the tag, build with WG_VERSION and WG_COMMIT, deploy, confirm 100% traffic, then observe production and export its result');
  if (!/^ {4}outputs:\n {6}result: \$\{\{ steps\.observe\.outputs\.result \}\}$/m.test(deploy) || !/^ {8}id: observe$/m.test(deploy)) {
    fail('deploy must export result only from its observe step');
  }
  return failures;
}
