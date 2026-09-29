import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkLiteralBashRuns, literalRunBlocks } from '../scripts/check-workflow-shell.mjs';

test('workflow shell checker catches the missing publish-job fi', () => {
  const broken = 'steps:\n  - run: |\n      if [ -n "$EXPECTED_SHA" ]; then\n        [ "$(git rev-parse HEAD)" = "$EXPECTED_SHA" ]\n';
  assert.equal(literalRunBlocks(broken).length, 1);
  assert.match(checkLiteralBashRuns(broken).join('\n'), /unexpected end of file/);
  assert.deepEqual(checkLiteralBashRuns(`${broken}      fi\n`), []);
});

test('both committed release workflows have valid literal Bash blocks', () => {
  for (const path of ['.github/workflows/release.yml', '.github/workflows/release-cutter.yml']) {
    assert.deepEqual(checkLiteralBashRuns(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')), [], path);
  }
});
