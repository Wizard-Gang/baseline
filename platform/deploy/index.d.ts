// Hand-written types for platform/deploy/verify.mjs and evidence.mjs, run by the reusable deploy-worker workflow.

export interface PollOptions {
  label: string;
  version: string;
  commit: string;
  timeoutMs?: number;
  intervalMs?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

export type Env = Record<string, string | undefined>;

export interface DeployResult {
  schema: 1;
  worker: string;
  host: string;
  repository: string;
  run_id: number;
  run_attempt: number;
  tag: string;
  commit: string;
  observed_at: string;
  worker_version_id: string;
  traffic_percentage: 100;
  assets_checked: number;
  checks: { reproduction: 'passed'; traffic: 'passed'; version: 'passed'; health: 'passed'; assets: 'passed' };
}

// verify.mjs
export function hostFor(label: string): string;
export function checkTraffic(input: { label: string; deployOutput: string; status: unknown }): string[];
export function checkIdentity(body: unknown, expected: { label: string; version: string; commit: string }): string[];
export function checkHealth(body: unknown, expected: { label: string; version: string }): string[];
export function pollVersion(options: PollOptions): Promise<string[]>;
export function verifyHealth(input: { label: string; version: string; commit: string; fetch?: typeof globalThis.fetch }): Promise<string[]>;
export function pageAssets(html: string, pageUrl: string): { url: string; kind: 'script' | 'style' }[];
export function verifyAssets(input: { label: string; fetch?: typeof globalThis.fetch }): Promise<{ failures: string[]; assets: number }>;
export function validateResult(result: unknown): string[];
export function buildResult(input: {
  label: string; tag: string; commit: string; env: Env; deploy: unknown; assets: number; observedAt: string;
}): { result?: DeployResult; failures: string[] };
export function observe(
  input: Omit<PollOptions, 'version'> & { tag: string; deployOutput: string; status: unknown; env: Env },
): Promise<{ result?: DeployResult; failures: string[] }>;
export function run(
  argv: string[],
  io?: Pick<PollOptions, 'fetch' | 'sleep' | 'now'> & {
    out?: (line: string) => void; err?: (line: string) => void; env?: Env; readFile?: (path: string) => string;
  },
): Promise<number>;

// evidence.mjs
export const DEPLOY_WORKFLOW: string;
export function callerReproduction(source: string, deploySha: string): { job: string; failures: string[] };
export function checkRun(
  run: unknown, expected: { repository: string; runId: string; attempt: string; tag: string; commit: string },
): { failures: string[]; deploySha: string; path: string };
export function checkReproductionJob(jobs: unknown, expected: { job: string; commit: string; attempt: string }): string[];
export function checkRelease(release: unknown, tag: string): string[];
export function checkVendorPin(lockText: string, deploySha: string): string[];
export function verifyEvidence(input: {
  tag: string; commit: string; env: Env; root?: string; fetch?: typeof globalThis.fetch; readFile?: (path: string) => string;
}): Promise<{ failures: string[]; job: string }>;
