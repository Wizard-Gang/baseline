import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function literalRunBlocks(workflow) {
  const lines = workflow.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(?:-\s+)?run:\s*\|\s*$/.exec(lines[index]);
    if (!match) continue;
    const indentation = match[1].length;
    const body = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (line.trim() && line.match(/^ */)[0].length <= indentation) break;
      body.push(line);
    }
    const margin = Math.min(...body.filter((line) => line.trim()).map((line) => line.match(/^ */)[0].length));
    blocks.push(body.map((line) => line.slice(Number.isFinite(margin) ? margin : 0)).join('\n'));
  }
  return blocks;
}

export function checkLiteralBashRuns(workflow) {
  return literalRunBlocks(workflow).flatMap((block, index) => {
    const source = block.replace(/\$\{\{[\s\S]*?\}\}/g, 'expression');
    const result = spawnSync('bash', ['-n'], { input: source, encoding: 'utf8' });
    return result.status === 0 ? [] : [`literal run block ${index + 1}: ${(result.stderr || result.error?.message || 'bash syntax error').trim()}`];
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = ['.github/workflows/release.yml', '.github/workflows/release-cutter.yml'];
  const failures = paths.flatMap((path) => checkLiteralBashRuns(readFileSync(resolve(root, path), 'utf8')).map((error) => `${path}: ${error}`));
  if (failures.length) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
  } else {
    console.log('Release workflow literal Bash blocks passed syntax checks.');
  }
}
