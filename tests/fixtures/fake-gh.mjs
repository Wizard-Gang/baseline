import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

// A stub `gh` executable on PATH, so the scripts spawn a real process. It serves secret and variable metadata from
// a JSON state file and appends every call's argv and stdin to a log, so tests can prove where a value travelled.
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
const scope = env ? repo.environments[env] : repo;
const key = option('--repo') + (env ? ':' + env : '');
if (!scope) fail('HTTP 404: environment not found');
if (argv[0] === 'variable' && argv[1] === 'list') {
  if (state.fail.includes('vars:' + key)) fail('HTTP 403: Resource not accessible');
  process.stdout.write(JSON.stringify(Object.entries(scope.variables).map(([name, updatedAt]) => ({ name, updatedAt }))));
  process.exit(0);
}
if (argv[0] === 'secret' && argv[1] === 'list') {
  if (state.fail.includes('list:' + key) || (state.writes.includes(key) && state.fail.includes('relist:' + key))) fail('HTTP 403: Resource not accessible');
  process.stdout.write(JSON.stringify(Object.entries(scope.secrets).map(([name, updatedAt]) => ({ name, updatedAt }))));
  process.exit(0);
}
if (argv[0] === 'secret' && argv[1] === 'set') {
  if (state.fail.includes('set:' + key)) fail('HTTP 403: Resource not accessible by integration');
  state.writes.push(key);
  if (!state.fail.includes('stale:' + key)) scope.secrets[argv[2]] = new Date(Date.parse(state.now) + 1000 * state.writes.length).toISOString().replace('.000', '');
  save();
  process.exit(0);
}
fail('fake gh: unsupported command ' + argv.join(' '));
`;

export const REPOSITORIES = Object.freeze([
  'Wizard-Gang/WizardGang', 'SouthernGentlemen/wizardgang-architecture-demo', 'Wizard-Gang/SharkTank', 'Wizard-Gang/Hexframe',
]);

export const DEMO = 'SouthernGentlemen/wizardgang-architecture-demo';
export const DEPLOY_DATE = '2026-10-04T18:34:10Z';
export const DEMO_DATE = '2026-10-04T18:45:02Z';
const scope = (secrets = {}, variables = {}) => ({ secrets, variables });

/** Every config repository exactly as config/secrets.json registers it, and nothing else. */
export function convergedRepos() {
  const repos = Object.fromEntries(REPOSITORIES.map((name) => [name, { ...scope(), environments: {
    production: scope({ CLOUDFLARE_API_TOKEN: DEPLOY_DATE }, { CLOUDFLARE_ACCOUNT_ID: '2026-10-04T19:00:00Z' }),
  } }]));
  repos[DEMO].environments.production.secrets.CLOUDFLARE_API_TOKEN = DEMO_DATE;
  repos[DEMO].environments['git-demo'] = scope({ GITHUB_APP_PRIVATE_KEY: '2026-10-04T19:10:00Z' }, { GITHUB_APP_ID: '2026-10-04T19:10:00Z' });
  return repos;
}

/** The 2026-10-04 live read (names and dates only): CLOUDFLARE_ACCOUNT_ID is still a secret everywhere. */
export function recordedRepos() {
  const repos = Object.fromEntries(REPOSITORIES.map((name) => [name, { ...scope(), environments: {
    production: scope({ CLOUDFLARE_ACCOUNT_ID: '2026-10-04T18:36:00Z', CLOUDFLARE_API_TOKEN: DEPLOY_DATE }),
  } }]));
  repos[DEMO].secrets.GIT_DEMO_PR_TOKEN = '2026-09-02T16:20:00Z';
  repos[DEMO].environments.production.secrets.CLOUDFLARE_API_TOKEN = DEMO_DATE;
  repos[DEMO].environments.production.variables.CLOUDFLARE_DO_NAMESPACE = '2026-08-31T18:29:30Z';
  repos['Wizard-Gang/SharkTank'].variables.PRODUCTION_DEPLOY_ENABLED = '2026-09-20T10:00:00Z';
  repos['Wizard-Gang/Hexframe'].environments.production.variables.PRODUCTION_HOST = '2026-09-14T09:00:00Z';
  return repos;
}

export function fakeGh({ repos = convergedRepos(), fail = [], authenticated = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  const state = join(dir, 'state.json');
  const log = join(dir, 'calls.jsonl');
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}\n${STUB}`);
  chmodSync(join(dir, 'gh'), 0o755);
  writeFileSync(state, JSON.stringify({ repos, fail, authenticated, writes: [], now: '2026-10-05T12:00:00Z' }));
  writeFileSync(log, '');
  return {
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, FAKE_GH_STATE: state, FAKE_GH_LOG: log },
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    state: () => JSON.parse(readFileSync(state, 'utf8')),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
