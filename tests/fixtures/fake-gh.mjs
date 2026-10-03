import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// A stub `gh` executable on PATH, so the scripts spawn a real process. It serves secret metadata from a JSON
// state file and appends every call's argv and stdin to a log, so tests can prove where a value travelled.
const STUB = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
const save = () => writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
const option = (name) => { const at = argv.indexOf(name); return at < 0 ? null : argv[at + 1]; };
const stdin = argv[0] === 'secret' && argv[1] === 'set' ? readFileSync(0, 'utf8') : '';
const envValues = Object.values(process.env);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ argv, stdin, envHasStdin: stdin !== '' && envValues.some((value) => value.includes(stdin)) }) + '\\n');
const fail = (message) => { process.stderr.write(message + '\\n'); process.exit(1); };
const repo = state.repos[option('--repo') ?? ''];
const env = option('--env');
if (argv[0] === 'auth' && argv[1] === 'status') process.exit(state.authenticated ? 0 : 1);
if (argv[0] === 'api') {
  const match = /^repos\\/([^/]+\\/[^/]+)\\/environments$/.exec(argv[1] ?? '');
  if (!match || !state.repos[match[1]]) fail('HTTP 404: Not Found');
  if (state.fail.includes('environments:' + match[1])) fail('HTTP 403: Resource not accessible by integration');
  process.stdout.write(JSON.stringify({ total_count: 0, environments: Object.keys(state.repos[match[1]].environments).map((name) => ({ name })) }));
  process.exit(0);
}
if (!repo) fail('HTTP 404: Not Found');
const scope = env ? repo.environments[env] : repo.secrets;
const key = option('--repo') + (env ? ':' + env : '');
if (!scope) fail('HTTP 404: environment not found');
if (argv[0] === 'secret' && argv[1] === 'list') {
  if (state.fail.includes('list:' + key) || (state.writes.includes(key) && state.fail.includes('relist:' + key))) fail('HTTP 403: Resource not accessible');
  process.stdout.write(JSON.stringify(Object.entries(scope).map(([name, updatedAt]) => ({ name, updatedAt }))));
  process.exit(0);
}
if (argv[0] === 'secret' && argv[1] === 'set') {
  if (state.fail.includes('set:' + key)) fail('HTTP 403: Resource not accessible by integration');
  state.writes.push(key);
  if (!state.fail.includes('stale:' + key)) scope[argv[2]] = new Date(Date.parse(state.now) + 1000 * state.writes.length).toISOString().replace('.000', '');
  save();
  process.exit(0);
}
fail('fake gh: unsupported command ' + argv.join(' '));
`;

export const REPOSITORIES = Object.freeze([
  'Wizard-Gang/WizardGang', 'SouthernGentlemen/wizardgang-architecture-demo', 'Wizard-Gang/SharkTank', 'Wizard-Gang/Hexframe',
]);

/** Every declared repository with a production environment holding the token, and nothing else. */
export function convergedRepos() {
  return Object.fromEntries(REPOSITORIES.map((name) => [name, {
    secrets: {}, environments: { production: { CLOUDFLARE_API_TOKEN: '2026-08-31T22:10:05Z', CLOUDFLARE_ACCOUNT_ID: '2026-08-29T01:57:48Z' } },
  }]));
}

/** The 2026-10-03 live read: the demo holds the token at repository level and has an empty production environment. */
export function recordedRepos() {
  const repos = convergedRepos();
  repos['SouthernGentlemen/wizardgang-architecture-demo'] = {
    secrets: { CLOUDFLARE_ACCOUNT_ID: '2026-08-31T18:29:27Z', CLOUDFLARE_API_TOKEN: '2026-08-31T22:10:07Z' },
    environments: { production: {} },
  };
  return repos;
}

export function fakeGh({ repos = convergedRepos(), fail = [], authenticated = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  const state = join(dir, 'state.json');
  const log = join(dir, 'calls.jsonl');
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}\n${STUB}`);
  chmodSync(join(dir, 'gh'), 0o755);
  writeFileSync(state, JSON.stringify({ repos, fail, authenticated, writes: [], now: '2026-10-03T12:00:00Z' }));
  writeFileSync(log, '');
  return {
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, FAKE_GH_STATE: state, FAKE_GH_LOG: log },
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    state: () => JSON.parse(readFileSync(state, 'utf8')),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
