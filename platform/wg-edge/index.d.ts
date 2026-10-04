// Hand-written types for the dependency-free wg-edge shell. Runtime: Cloudflare Workers (and Node 26 in tests).

export type AppName = 'wizardgang' | 'demo' | 'sharktank' | 'hexframe';
export type LogLevel = 'info' | 'warn' | 'error';
export type Logger = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

/** A Secrets Store binding, or a plain Worker secret string. */
export type SecretBinding = string | { get(): Promise<string> };

/** Minimal D1 surface the helpers use. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  };
}

/** Minimal R2 surface the helper uses. Options and objects pass through untouched. */
export interface R2Like {
  get(key: string, options?: unknown): Promise<unknown>;
  head(key: string): Promise<unknown>;
  put(key: string, value: unknown, options?: unknown): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit: number }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
}

export interface EdgeEnv {
  WG_APP: AppName;
  WG_OPS_TOKEN?: SecretBinding;
  WG_SESSION_KEY?: SecretBinding;
  WG_DB?: D1Like;
  WG_R2?: R2Like;
  /** Numeric GitHub App ID, a plain var on the Workers the registry lists as App consumers. */
  GITHUB_APP_ID?: string;
  /** PKCS#8 PEM RSA key of the wg-github-app credential: a Worker secret (a Secrets Store binding also reads). */
  GITHUB_APP_PRIVATE_KEY?: SecretBinding;
  [binding: string]: unknown;
}

export interface Release {
  /** Semantic version, e.g. "1.4.0". */
  version: string;
  /** Full 40-character lowercase commit SHA. */
  commit: string;
}

export interface FetchContext {
  app: AppName;
  url: URL;
  requestId: string;
  /** True only when the path is /admin or /admin/* and the operator gate admitted the request. */
  admin: boolean;
  log: Logger;
  release: Readonly<Release>;
}

export interface ScheduledContext {
  app: AppName;
  log: Logger;
  release: Readonly<Release>;
}

export interface EdgeOptions<Env extends EdgeEnv = EdgeEnv> {
  release: Release;
  /** Return null or undefined for an Accept-driven 404. */
  fetch?(request: Request, env: Env, ctx: unknown, edge: FetchContext): Response | null | undefined | Promise<Response | null | undefined>;
  scheduled?(controller: { cron?: string; scheduledTime?: number }, env: Env, ctx: unknown, edge: ScheduledContext): void | Promise<void>;
  /** Return false, or throw, to report 503 degraded. */
  health?(env: Env): boolean | void | Promise<boolean | void>;
  /** Replaces DEFAULT_ROBOTS. */
  robots?: string;
  /** Receives each JSON log line. Defaults to console.log. */
  logSink?(line: string): void;
}

export interface EdgeHandler<Env extends EdgeEnv = EdgeEnv> {
  fetch(request: Request, env: Env, ctx: unknown): Promise<Response>;
  scheduled(controller: { cron?: string; scheduledTime?: number }, env: Env, ctx: unknown): Promise<void>;
}

export function createEdge<Env extends EdgeEnv = EdgeEnv>(options: EdgeOptions<Env>): EdgeHandler<Env>;
export const DEFAULT_ROBOTS: string;

export interface WorkerIdentity {
  host: string;
  aliases: readonly string[];
  prefix: string;
}
export const WORKERS: Readonly<Record<AppName, Readonly<WorkerIdentity>>>;
export function workerIdentity(env: { WG_APP?: unknown } | undefined): { app: AppName } & WorkerIdentity;
export class ConfigurationError extends Error {}

export const OPS_USERNAME: 'ops';
export function readSecret(binding: unknown): Promise<string>;
export function sessionKey(env: { WG_SESSION_KEY?: unknown }): Promise<string>;
export function constantTimeEqual(a: string, b: string): Promise<boolean>;

/** Labels mirrored from the registry's derived entries. */
export type DerivedKeyLabel = 'demo-session' | 'identity-session' | 'identity-audit';
export const DERIVED_KEYS: Readonly<Record<DerivedKeyLabel, Readonly<{ consumers: readonly AppName[] }>>>;
/** 32 bytes of HKDF-SHA256 key material from WG_SESSION_KEY. Throws ConfigurationError on an undeclared label, a non-consumer Worker or a missing root. */
export function deriveKey(env: { WG_APP?: unknown; WG_SESSION_KEY?: unknown }, label: DerivedKeyLabel): Promise<Uint8Array>;

export type GitHubPermissionLevel = 'read' | 'write' | 'admin';
export const GITHUB_APP: Readonly<{ id: 'GITHUB_APP_ID'; privateKey: 'GITHUB_APP_PRIVATE_KEY'; credential: 'wg-github-app'; consumers: readonly AppName[] }>;
export class GitHubAppError extends Error {}
export interface GitHubAppTokenRequest {
  installationId: number | string;
  /** At least one permission; the token holds exactly these. */
  permissions: Record<string, GitHubPermissionLevel>;
}
export interface GitHubAppTokenOptions {
  fetch?: typeof fetch;
  now?: () => number;
  cache?: Map<string, Promise<{ token: string; expiresAt: number }>>;
}
/** An installation token, cached per App, installation and permission set until 5 minutes before expiry. Throws GitHubAppError. */
export function githubAppToken(env: { GITHUB_APP_ID?: unknown; GITHUB_APP_PRIVATE_KEY?: unknown }, request: GitHubAppTokenRequest, options?: GitHubAppTokenOptions): Promise<string>;

export const SECURITY_HEADERS: Readonly<Record<string, string>>;
export function json(data: unknown, status?: number, headers?: Record<string, string>): Response;
export function text(text: string, status?: number, headers?: Record<string, string>): Response;
export function wantsHtml(request: Request): boolean;
export function problem(request: Request, status: number, title: string, requestId: string, headers?: Record<string, string>): Response;
export function notFound(request: Request, requestId: string): Response;
export function createLogger(app: string, sink?: (line: string) => void): Logger;

export interface StoredRecord<T = unknown> {
  collection: string;
  id: string;
  body: T;
  owner: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}
export interface StoredEvent<T = unknown> {
  kind: string;
  at: number;
  body: T;
  expiresAt: number | null;
}
export interface Clock {
  now?: () => number;
}

export interface Records {
  get<T = unknown>(collection: string, id: string): Promise<StoredRecord<T> | null>;
  put(collection: string, id: string, body: unknown, options?: { owner?: string | null; ttlSeconds?: number }): Promise<void>;
  delete(collection: string, id: string): Promise<boolean>;
  list<T = unknown>(collection: string, options?: { owner?: string; limit?: number }): Promise<Array<StoredRecord<T>>>;
}
export interface Events {
  append(kind: string, body: unknown, options?: { ttlSeconds?: number }): Promise<number>;
  list<T = unknown>(kind: string, options?: { since?: number; limit?: number }): Promise<Array<StoredEvent<T>>>;
}
export interface Bucket {
  readonly prefix: string;
  get(key: string, options?: unknown): Promise<unknown>;
  head(key: string): Promise<unknown>;
  put(key: string, value: unknown, options?: unknown): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string }>; keys: string[]; truncated: boolean; cursor?: string }>;
}

export function records(env: EdgeEnv, options?: Clock): Records;
export function events(env: EdgeEnv, options?: Clock): Events;
export function bucket(env: EdgeEnv): Bucket;
export function sweepExpired(env: EdgeEnv, options?: Clock): Promise<{ records: number; events: number }>;
