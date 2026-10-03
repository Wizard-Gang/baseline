#!/usr/bin/env node
// The vendored conformance commands, run from the consumer repository root:
//   node platform/conformance/cli.mjs pin                                   vendored platform/ matches its lock
//   node platform/conformance/cli.mjs wrangler --worker <label> [config]    wrangler config conforms (default wrangler.jsonc)
//   node platform/conformance/cli.mjs render --worker <label> --store-id <id>  print a starting config from the template
// Exit codes: 0 conformant, 1 nonconformant, 2 usage error. Nothing here reads a provider or the network.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderWranglerTemplate } from './template.mjs';
import { verifyVendored } from './vendor.mjs';
import { checkWranglerSource } from './wrangler.mjs';

const USAGE = 'usage: cli.mjs pin [--root <dir>] | wrangler --worker <label> [config] | render --worker <label> --store-id <id>';

/** @param {string[]} args */
function parse(args) {
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) positional.push(arg);
    else if (['--root', '--worker', '--store-id'].includes(arg) && index + 1 < args.length) options[arg.slice(2)] = args[++index];
    else throw new Error(`unknown or incomplete option ${arg}`);
  }
  return { options, positional };
}

/**
 * @param {string[]} argv command and arguments
 * @param {{ cwd?: string, out?: (line: string) => void, err?: (line: string) => void }} [io]
 * @returns {number} the exit code
 */
export function run(argv, { cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  const [command, ...rest] = argv;
  let parsed;
  try {
    parsed = parse(rest);
  } catch (error) {
    err(`${error.message}\n${USAGE}`);
    return 2;
  }
  const { options, positional } = parsed;
  const report = (failures, ok) => {
    for (const failure of failures) err(`FAIL ${failure}`);
    if (!failures.length) out(ok);
    return failures.length ? 1 : 0;
  };
  if (command === 'pin' && !positional.length && !options.worker && !options['store-id']) {
    const root = resolve(cwd, options.root ?? '.');
    return report(verifyVendored(root), `Vendored platform/ matches platform/vendor.lock.json in ${root}`);
  }
  if (command === 'wrangler' && options.worker && positional.length <= 1 && !options.root && !options['store-id']) {
    const path = resolve(cwd, positional[0] ?? 'wrangler.jsonc');
    let source;
    try {
      source = readFileSync(path, 'utf8');
    } catch {
      return report([`cannot read ${path}`], '');
    }
    return report(checkWranglerSource(source, options.worker), `${path} conforms for Worker ${options.worker}`);
  }
  if (command === 'render' && options.worker && options['store-id'] && !positional.length && !options.root) {
    const template = readFileSync(fileURLToPath(new URL('../wrangler.template.jsonc', import.meta.url)), 'utf8');
    try {
      out(JSON.stringify(renderWranglerTemplate(template, options.worker, { secretsStoreId: options['store-id'] }), null, 2));
      return 0;
    } catch (error) {
      err(`FAIL ${error.message}`);
      return 1;
    }
  }
  err(USAGE);
  return 2;
}

// realpath on both sides: a symlinked checkout path must still run, never silently exit 0.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = run(process.argv.slice(2));
}
