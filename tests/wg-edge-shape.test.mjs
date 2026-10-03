import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import * as shell from '../platform/wg-edge/index.mjs';

const dir = new URL('../platform/wg-edge/', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');
const modules = readdirSync(dir).filter((name) => name.endsWith('.mjs'));

test('the Worker table mirrors config/cloudflare.json hosts, aliases and R2 prefixes', () => {
  const desired = JSON.parse(readFileSync(new URL('../config/cloudflare.json', import.meta.url), 'utf8'));
  const prefixes = desired.r2.find((bucket) => bucket.name === 'wizardgang').prefixes;
  const expected = Object.fromEntries(Object.entries(desired.workers).map(([app, worker]) => [
    app, { host: worker.host, aliases: worker.aliases, prefix: prefixes[app].prefix },
  ]));
  assert.deepEqual(JSON.parse(JSON.stringify(shell.WORKERS)), expected);
  assert.ok(Object.isFrozen(shell.WORKERS) && Object.values(shell.WORKERS).every((worker) => Object.isFrozen(worker.aliases)));
});

test('the shell is dependency-free ESM: relative imports only, no Node built-ins', () => {
  for (const name of modules) {
    const specifiers = [...read(name).matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    for (const specifier of specifiers) assert.match(specifier, /^\.\/[a-z-]+\.mjs$/, `${name} imports ${specifier}`);
    const code = read(name).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\brequire\(|\bimport\(/, `${name} must not load modules dynamically`);
  }
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
});

test('the hand-written .d.ts declares every runtime export and nothing else', () => {
  const declared = new Set([...read('index.d.ts').matchAll(/^export (?:function|const|class) ([A-Za-z_]+)/gm)].map((match) => match[1]));
  assert.deepEqual([...declared].sort(), Object.keys(shell).sort());
});

test('each shell file stays reviewable', () => {
  for (const name of readdirSync(dir)) {
    assert.ok(read(name).split('\n').length <= 250, `${name} exceeds 250 lines`);
  }
});
