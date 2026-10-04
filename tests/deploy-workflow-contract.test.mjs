import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEPLOY_WORKFLOW, runCommands, validateDeployWorkflow, WRANGLER_DEPLOY } from '../scripts/deploy-workflow-contract.mjs';
import { validateRepositoryAt, validateRepositoryContract } from '../scripts/repository-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const workflow = read(DEPLOY_WORKFLOW);
const rejects = (source, pattern) => assert.match(validateDeployWorkflow(source).join('\n'), pattern);
const edit = (from, to) => {
  assert.ok(workflow.includes(from), `fixture text is missing: ${from}`);
  return workflow.replace(from, to);
};

test('the committed deploy workflow satisfies its contract', () => {
  assert.deepEqual(validateDeployWorkflow(workflow), []);
  assert.deepEqual(validateDeployWorkflow(''), [`missing ${DEPLOY_WORKFLOW}`]);
});

test('the workflow is call-only and can never run inside baseline', () => {
  const triggers = [
    'on:\n  push:\n    branches: [main]\n',
    'on:\n  pull_request:\n',
    "on:\n  push:\n    tags: ['v*']\n",
    'on:\n  workflow_dispatch:\n',
    "on:\n  schedule:\n    - cron: '0 0 * * *'\n",
    'on:\n  workflow_run:\n    workflows: [CI]\n',
  ];
  for (const trigger of triggers) rejects(edit('on:\n', trigger), /must trigger only on workflow_call/);
  rejects(edit('    inputs:\n', '    secrets:\n      CLOUDFLARE_API_TOKEN:\n        required: true\n    inputs:\n'), /never secrets or outputs/);
  rejects(edit('      expected_sha:\n        description: Full commit the tag must point to\n        required: true\n', '      expected_sha:\n        description: Full commit the tag must point to\n        required: false\n'), /expected_sha must be a required string/);
  rejects(edit('      tag:\n', '      ref:\n'), /inputs must be exactly worker, tag, expected_sha/);
});

test('only the deploy job binds the caller\'s production environment and reads its Cloudflare token secret', () => {
  rejects(edit('      name: production\n', '      name: staging\n'), /production environment/);
  rejects(edit('    environment:\n      name: production\n      url: ${{ needs.verify.outputs.url }}\n', ''), /production environment/);
  rejects(edit('    needs: verify\n', ''), /deploy must need verify/);
  rejects(edit('    outputs:\n', '    environment:\n      name: production\n    outputs:\n'), /verify must not bind an environment/);
  rejects(edit('      - name: Install locked dependencies\n        run: npm ci\n      - name: Reproduce',
    '      - name: Install locked dependencies\n        env:\n          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n        run: npm ci\n      - name: Reproduce'), /verify must not read secrets/);
  rejects(edit('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}', 'CLOUDFLARE_API_TOKEN: ${{ secrets.GH_ADMIN_TOKEN }}'), /may read only the secret CLOUDFLARE_API_TOKEN/);
  rejects(edit('      - name: Install locked dependencies\n        run: npm ci\n      - name: Reproduce',
    '      - name: Install locked dependencies\n        env:\n          CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}\n        run: npm ci\n      - name: Reproduce'), /verify must not read variables/);
  rejects(edit('CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}', 'CLOUDFLARE_ACCOUNT_ID: ${{ vars.PRODUCTION_HOST }}'), /no other variable/);
  rejects(`${workflow}        with:\n          secrets: inherit\n`, /never inherit caller secrets/);
});

test('the deploy reads CLOUDFLARE_ACCOUNT_ID only as the registry variable, never as a secret', () => {
  assert.equal(workflow.match(/CLOUDFLARE_ACCOUNT_ID: \$\{\{ vars\.CLOUDFLARE_ACCOUNT_ID \}\}/g)?.length, 2);
  assert.ok(!workflow.includes('secrets.CLOUDFLARE_ACCOUNT_ID'));
  const asSecret = workflow.replaceAll('${{ vars.CLOUDFLARE_ACCOUNT_ID }}', '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
  rejects(asSecret, /never secrets\.CLOUDFLARE_ACCOUNT_ID/);
  rejects(asSecret, /must read CLOUDFLARE_ACCOUNT_ID as vars\.CLOUDFLARE_ACCOUNT_ID/);
  rejects(workflow.replace('CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}', 'CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}'), /never secrets\.CLOUDFLARE_ACCOUNT_ID/);
});

test('actions stay SHA-pinned and the token stays read-only', () => {
  rejects(workflow.replace(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@v7'), /pinned to a full commit SHA/);
  rejects(workflow.replace(/actions\/setup-node@[0-9a-f]{40}/, 'someone/setup-node@0123456789012345678901234567890123456789'), /GitHub-owned/);
  rejects(edit('permissions:\n  contents: read\n', 'permissions:\n  contents: write\n'), /contents: read/);
  rejects(edit('    timeout-minutes: 30\n', '    timeout-minutes: 30\n    permissions:\n      id-token: write\n'), /deploy must not broaden/);
  rejects(edit('  cancel-in-progress: false\n', '  cancel-in-progress: true\n'), /without cancelling a deploy/);
});

test('inputs reach shell only through env, in plain run blocks', () => {
  rejects(edit('run: node platform/conformance/cli.mjs pin', 'run: node platform/conformance/cli.mjs pin --root ${{ inputs.worker }}'), /never \$\{\{ \}\}/);
  rejects(edit('[[ "$WORKER" =~', '[[ "${{ inputs.worker }}" =~'), /never \$\{\{ \}\}/);
  rejects(edit('        run: npm run check\n', '        run: >-\n          npm run check\n'), /plain \| block/);
});

test('the tag is bound to package.json and the commit before checks, pin and conformance', () => {
  rejects(edit('[ "$(git cat-file -t "refs/tags/$RELEASE_TAG")" = tag ] || { echo "::error::$RELEASE_TAG is lightweight"; exit 1; }\n          [ "$(git rev-parse "refs/tags/$RELEASE_TAG^{commit}")" = "$EXPECTED_SHA" ] || { echo "::error::$RELEASE_TAG does not point', '[ "$(git rev-parse "refs/tags/$RELEASE_TAG^{commit}")" = "$EXPECTED_SHA" ] || { echo "::error::$RELEASE_TAG does not point'), /annotated tag/);
  rejects(edit('[ "v$version" = "$RELEASE_TAG" ]', 'true'), /annotated tag to package\.json/);
  rejects(edit('        run: npm run check\n', '        run: npm test\n'), /npm run check/);
  rejects(edit('        run: node platform/conformance/cli.mjs pin\n', ''), /pin and wrangler conformance/);
  rejects(edit('wrangler --worker "$WORKER"\n', 'wrangler --worker hexframe\n'), /wrangler conformance/);
  rejects(workflow.replaceAll('ref: refs/tags/${{ inputs.tag }}', 'ref: main'), /check out the caller's tag/);
});

test('the deploy can never auto-create resources, and is the only wrangler mutation', () => {
  assert.equal(runCommands(workflow).filter((command) => command.includes(WRANGLER_DEPLOY)).length, 1);
  for (const flag of [' --experimental-provision=false', ' --experimental-auto-create=false']) {
    rejects(edit(flag, ''), /the only wrangler deploy must be/);
  }
  rejects(edit('npx --no-install wrangler deploy \\', 'npx wrangler deploy \\'), /the only wrangler deploy must be/);
  rejects(edit('npm run build --if-present\n', 'npm run build --if-present && npx wrangler deploy\n'), /the only wrangler deploy must be/);
  for (const command of ['npx --no-install wrangler d1 create wizardgang', 'npx --no-install wrangler r2 bucket create wizardgang', 'npx --no-install wrangler rollback']) {
    rejects(edit('          npx --no-install wrangler --version\n', `          ${command}\n`), /other mutating wrangler command/);
  }
});

test('deploy confirms 100% traffic and then the public /version.json identity', () => {
  rejects(edit('node platform/deploy/verify.mjs traffic', 'echo skipped'), /confirm 100% traffic/);
  rejects(edit('wrangler deployments status --name "$WORKER" --json', 'wrangler deployments list'), /confirm 100% traffic/);
  rejects(edit('--version "${RELEASE_TAG#v}"', '--version "$RELEASE_TAG"'), /poll \/version\.json/);
  rejects(edit('--commit "$EXPECTED_SHA"\n', '--commit "$(git rev-parse HEAD)"\n'), /poll \/version\.json/);
  rejects(edit('      - name: Confirm the public /version.json identity\n', '').replace(/        shell: bash\n        run: \|\n          set -euo pipefail\n          node platform\/deploy\/verify\.mjs version[^\n]*\n$/, ''), /poll \/version\.json/);
});

test('baseline never deploys: no other workflow, script, dependency or config reaches wrangler', (t) => {
  const specimen = () => ({
    ci: read('.github/workflows/ci.yml'),
    release: read('.github/workflows/release.yml'),
    cutter: read('.github/workflows/release-cutter.yml'),
    deploy: workflow,
    pkg: JSON.parse(read('package.json')),
    lock: JSON.parse(read('package-lock.json')),
    phase: JSON.parse(read('config/phase.json')),
    provider: JSON.parse(read('config/github-repository-settings.json')),
  });
  const contains = (input, text) => validateRepositoryContract(input).some((failure) => failure.includes(text));
  assert.deepEqual(validateRepositoryContract(specimen()), []);
  for (const [key, name, addition] of [
    ['ci', 'CI', '  deploy:\n    uses: ./.github/workflows/deploy-worker.yml\n'],
    ['release', 'Release', '      - run: npx wrangler deploy\n'],
    ['cutter', 'Release cutter', '    environment: production\n'],
  ]) {
    const input = specimen();
    input[key] += addition;
    assert.ok(contains(input, `${name} workflow must never deploy`), name);
  }
  let input = specimen();
  input.pkg.scripts.deploy = 'wrangler deploy';
  assert.ok(contains(input, 'package scripts must never deploy'));
  input = specimen();
  input.pkg.devDependencies = { wrangler: '4.147.0' };
  assert.ok(contains(input, 'must not depend on wrangler'));
  input = specimen();
  input.deploy = workflow.replace('on:\n', 'on:\n  push:\n    branches: [main]\n');
  assert.ok(contains(input, 'deploy-worker: must trigger only on workflow_call'));

  const copy = mkdtempSync(join(tmpdir(), 'baseline-deploy-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(root, copy, { recursive: true, filter: (source) => !/^(?:\.git|node_modules)(?:[\\/]|$)/.test(relative(root, source)) });
  assert.deepEqual(validateRepositoryAt(copy), []);
  writeFileSync(join(copy, '.github/workflows/deploy-production.yml'), 'on:\n  push:\n');
  assert.ok(validateRepositoryAt(copy).includes('workflows must be exactly ci.yml, deploy-worker.yml, release-cutter.yml, release.yml'));
  rmSync(join(copy, '.github/workflows/deploy-production.yml'));
  writeFileSync(join(copy, 'wrangler.jsonc'), '{}\n');
  assert.ok(validateRepositoryAt(copy).includes('baseline never deploys and must not carry wrangler.jsonc'));
  rmSync(join(copy, 'wrangler.jsonc'));
  rmSync(join(copy, DEPLOY_WORKFLOW));
  assert.ok(validateRepositoryAt(copy).includes(`missing or empty repository authority: ${DEPLOY_WORKFLOW}`));
});
