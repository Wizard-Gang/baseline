import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkLiteralBashRuns, literalRunBlocks, workflowPaths } from '../scripts/check-workflow-shell.mjs';

test('workflow shell checker catches the missing publish-job fi', () => {
  const broken = 'steps:\n  - run: |\n      if [ -n "$EXPECTED_SHA" ]; then\n        [ "$(git rev-parse HEAD)" = "$EXPECTED_SHA" ]\n';
  assert.equal(literalRunBlocks(broken).length, 1);
  assert.match(checkLiteralBashRuns(broken).join('\n'), /unexpected end of file/);
  assert.deepEqual(checkLiteralBashRuns(`${broken}      fi\n`), []);
});

test('every committed workflow, including the reusable deploy, has valid literal Bash blocks', () => {
  const paths = workflowPaths();
  assert.deepEqual(paths, ['ci.yml', 'deploy-worker.yml', 'release-cutter.yml', 'release.yml'].map((name) => `.github/workflows/${name}`));
  assert.equal(literalRunBlocks(readFileSync(new URL('../.github/workflows/deploy-worker.yml', import.meta.url), 'utf8')).length, 8);
  for (const path of paths) {
    assert.deepEqual(checkLiteralBashRuns(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')), [], path);
  }
});
