// Shared parsing for the owner runbooks (docs/CLOUDFLARE-RUNBOOK.md and docs/SECRETS-RUNBOOK.md) and their tests.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const WRANGLER = 'npx --yes wrangler@4.147.0';
export const ACCOUNT_ID_INLINE = `A="$(${WRANGLER} whoami --json | jq -r '.accounts[0].id')"`;
// Variables a fresh macOS shell always has.
const SHELL_VARIABLES = new Set(['HOME', 'USER', 'TMPDIR', 'PATH']);

/** `## part` / `### title` sections, each with the body text up to the next heading. */
export function sections(text) {
  const found = [];
  let part = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) part = line.slice(3);
    else if (line.startsWith('### ')) found.push({ part, title: line.slice(4), body: '' });
    else if (found.length && found.at(-1).part === part) found.at(-1).body += `${line}\n`;
  }
  return found;
}

/** True when the body lists each `- **Label:**` bullet, in this order. */
export function hasPartsInOrder(body, labels) {
  const at = labels.map((label) => body.indexOf(`- **${label}:**`));
  return at.every((index, i) => index >= 0 && (i === 0 || index > at[i - 1]));
}

/** Every fenced block and every inline code span: the units a terminal run executes one at a time. */
export function commands(text) {
  const blocks = [];
  const prose = text.replace(/^( *)```[a-z]*\n([\s\S]*?)\n\1```$/gm, (_, indent, body) => {
    blocks.push(body.split('\n').map((line) => line.slice(indent.length)).join('\n'));
    return '';
  });
  return [...blocks, ...[...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1])];
}

/** Shell variables a command reads without assigning them itself (heredoc bodies and single quotes ignored). */
export function undefinedVariables(command) {
  const code = command.replace(/<<'(\w+)'[^\n]*\n[\s\S]*?\n\s*\1(?=\n|$)/g, (heredoc) => heredoc.split('\n')[0])
    .replace(/'[^'\n]*'/g, "''");
  const defined = new Set(SHELL_VARIABLES);
  for (const [, name] of code.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=/g)) defined.add(name);
  for (const [, name] of code.matchAll(/\b(?:read -r|for)\s+([A-Za-z_]\w*)/g)) defined.add(name);
  const used = [...code.matchAll(/\$\{?([A-Za-z_]\w*)/g)].map((match) => match[1]);
  return [...new Set(used.filter((name) => !defined.has(name)))];
}

/** GitHub's heading anchor: lower-case, punctuation other than `-` and `_` dropped, spaces to hyphens. */
export const anchor = (heading) => heading.toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-');

/** Relative links, and those whose file or Markdown heading anchor does not resolve from the docs directory. */
export function brokenLinks(text, root) {
  const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]).filter((link) => !/^[a-z]+:/.test(link) && !link.startsWith('#'));
  const broken = links.filter((link) => {
    const [path, fragment] = link.split('#');
    const file = resolve(root, 'docs', path);
    if (!existsSync(file)) return true;
    if (fragment === undefined) return false;
    const headings = readFileSync(file, 'utf8').split('\n').filter((line) => /^#{1,6} /.test(line));
    return !headings.some((line) => anchor(line.replace(/^#+ /, '')) === fragment);
  });
  return { links, broken };
}

/** `npm run` script names a runbook uses. */
export const npmScripts = (text) => new Set([...text.matchAll(/npm run (?:--silent )?([a-z][a-z0-9:-]*)/g)].map((match) => match[1]));

/** Every `for r in …` repository list. */
export const repositoryLoops = (text) => [...text.matchAll(/for r in ([^;]+); do/g)].map((match) => match[1].trim().split(/\s+/));

/** The runbook-wide rules both owner runbooks share: self-contained commands, one wrangler pin, no values or IDs. */
export function sharedRunbookFailures(text) {
  const failures = [];
  for (const command of commands(text)) {
    const missing = undefinedVariables(command);
    if (missing.length) failures.push(`not self-contained (reads ${missing.join(', ')}): ${command.split('\n')[0].slice(0, 90)}`);
  }
  for (const [call] of text.matchAll(/npx(?: --yes)? wrangler(?:@\S+)?/g)) if (call !== WRANGLER) failures.push(`wrangler must run as ${WRANGLER}: found ${call}`);
  if (/\b(?:cfverify|cfget)\b|\bwr (?=[a-z])|## Session setup|\$CLOUDFLARE_ACCOUNT_ID|\$STORE_ID/.test(text)) failures.push('session helpers or exported session variables');
  if (/\b[0-9a-f]{32}\b/i.test(text)) failures.push('a 32-hex account or object ID');
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text)) failures.push('a UUID');
  if (/[A-Za-z0-9_-]{40,}/.test(text.replace(/\]\([^)\s]+\)/g, ']()'))) failures.push('a token-like value');
  if (/--(?:value|body)\b/.test(text)) failures.push('a value passed as an argument');
  if (/\b\d{6,}\b/.test(text)) failures.push('a numeric App or installation ID');
  return failures;
}
