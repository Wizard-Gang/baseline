// Hand-written types for platform/deploy/verify.mjs, run by the reusable deploy-worker workflow.

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

// verify.mjs
export function hostFor(label: string): string;
export function checkTraffic(input: { label: string; deployOutput: string; status: unknown }): string[];
export function checkIdentity(body: unknown, expected: { label: string; version: string; commit: string }): string[];
export function pollVersion(options: PollOptions): Promise<string[]>;
export function run(
  argv: string[],
  io?: Pick<PollOptions, 'fetch' | 'sleep' | 'now'> & { out?: (line: string) => void; err?: (line: string) => void },
): Promise<number>;
