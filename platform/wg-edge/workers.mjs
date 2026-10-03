// The Workers this shell may run as, mirrored from baseline config/cloudflare.json. The shell is vendored
// without that file, so the table is code; a baseline test fails if the two ever disagree.

/** @typedef {{ host: string, aliases: readonly string[], prefix: string }} WorkerIdentity */

/** @type {Readonly<Record<string, Readonly<WorkerIdentity>>>} */
export const WORKERS = Object.freeze({
  wizardgang: Object.freeze({ host: 'wizardgang.ai', aliases: Object.freeze(['www.wizardgang.ai']), prefix: 'wizardgang/' }),
  demo: Object.freeze({ host: 'demo.wizardgang.ai', aliases: Object.freeze([]), prefix: 'demo/' }),
  sharktank: Object.freeze({ host: 'sharktank.wizardgang.ai', aliases: Object.freeze([]), prefix: 'sharktank/' }),
  hexframe: Object.freeze({ host: 'hexframe.wizardgang.ai', aliases: Object.freeze([]), prefix: 'hexframe/' }),
});

/**
 * The declared identity for `env.WG_APP`. Anything else is a misconfigured Worker and is refused,
 * so a typo can never fall through to another app's host, rows or keys.
 * @param {{ WG_APP?: unknown } | undefined} env
 * @returns {{ app: string } & WorkerIdentity}
 */
export function workerIdentity(env) {
  const app = env?.WG_APP;
  if (typeof app !== 'string' || !Object.hasOwn(WORKERS, app)) {
    throw new ConfigurationError('WG_APP must name a declared Worker');
  }
  return { app, ...WORKERS[app] };
}

/**
 * Classify the request host against the Worker's declared hosts.
 * @param {string} hostname
 * @param {WorkerIdentity} identity
 * @returns {'canonical' | 'alias' | 'foreign'}
 */
export function classifyHost(hostname, identity) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === identity.host) return 'canonical';
  if (identity.aliases.includes(host)) return 'alias';
  return 'foreign';
}

/** A deployment mistake, not a request error. The boundary logs its message and answers 500. */
export class ConfigurationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}
