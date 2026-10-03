// Hand-written types for the vendored conformance modules. Each module is imported by path; there is no index.mjs.

export interface WorkerEntry {
  host: string;
  aliases: readonly string[];
  durableObjects: readonly string[];
  crons: readonly string[];
  secrets?: readonly string[];
}

export interface DesiredPolicy {
  compatibility: { date: string; flags: readonly string[] };
  workerSettings: { observability: boolean; workersDev: boolean; previewUrls: boolean };
  d1: { binding: 'WG_DB'; name: string };
  r2: { binding: 'WG_R2'; name: string };
  secretsStoreSecrets: readonly string[];
  workers: Readonly<Record<string, WorkerEntry>>;
}

export interface VendorLock {
  schemaVersion: 1;
  source: 'Wizard-Gang/baseline';
  commit: string;
  files: Record<string, string>;
}

// desired.mjs
export const DESIRED: DesiredPolicy;

// jsonc.mjs
export function parseJsonc(source: string): unknown;

// wrangler.mjs
export function checkWranglerConfig(
  config: unknown,
  target: { label: string; worker: WorkerEntry; shared?: DesiredPolicy },
): string[];
export function checkWranglerSource(source: string, label: string, shared?: DesiredPolicy): string[];

// template.mjs
export function renderWranglerTemplate(
  template: string,
  label: string,
  ids: { secretsStoreId: string },
  shared?: DesiredPolicy,
): Record<string, unknown>;

// vendor.mjs
export const LOCK_FILE: 'vendor.lock.json';
export const SOURCE: 'Wizard-Gang/baseline';
export function sha256(content: string | Uint8Array): string;
export function buildLock(commit: string, files: Map<string, string | Uint8Array>): VendorLock;
export function formatLock(lock: VendorLock): string;
export function validateLockShape(lock: unknown): string[];
export function compareVendored(lock: unknown, files: Map<string, string | Uint8Array>, unsafe?: string[]): string[];
export function verifyVendored(root: string): string[];

// cli.mjs
export function run(
  argv: string[],
  io?: { cwd?: string; out?: (line: string) => void; err?: (line: string) => void },
): 0 | 1 | 2;
