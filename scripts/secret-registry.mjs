import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKERS, scanForCommittedValues } from './cloudflare-desired-state.mjs';

// The closed WizardGang secret registry. `config/secrets.json` names every secret, variable and derived key, its
// home and its consumers; this module rejects anything outside the naming rules. It holds names only, never a value.
export const KINDS = Object.freeze(['secret', 'variable', 'derived']);
export const HOMES = Object.freeze(['worker', 'secrets-store', 'github-environment', 'keychain']);
// Provider → the name prefix its secrets and variables carry. Shared platform secrets use WG_.
export const PROVIDERS = Object.freeze({
  cloudflare: 'CLOUDFLARE', demo: 'DEMO', github: 'GITHUB', google: 'GOOGLE', microsoft: 'MICROSOFT', saml: 'SAML', wizardgang: 'WG',
});
export const SECRET_KINDS = Object.freeze(['TOKEN', 'CLIENT_SECRET', 'WEBHOOK_SECRET', 'PRIVATE_KEY', 'KEY']);
export const DERIVED_SOURCE = 'WG_SESSION_KEY';
// Wrangler's own names: kept as-is, and only in GitHub environments.
export const WRANGLER_GITHUB_NAMES = Object.freeze(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);
// GitHub refuses Actions secret and variable names that start with GITHUB_, so a github name in a GitHub environment
// drops its provider prefix: APP_PRIVATE_KEY in git-demo is the Worker's GITHUB_APP_PRIVATE_KEY.
export const GITHUB_RESERVED_PREFIX = 'GITHUB_';
const dropsProviderPrefix = (entry) => entry?.home === 'github-environment' && entry?.provider === 'github';
/** The provider-prefixed form of an entry's name, which one console credential maps to in every home. */
export const canonicalName = (entry) => (dropsProviderPrefix(entry) ? `${PROVIDERS.github}_${entry.name}` : entry.name);

const TOP_LEVEL_KEYS = ['schemaVersion', 'entries', 'exceptions'];
const ENTRY_KEYS = ['name', 'kind', 'home', 'consumers', 'provider', 'credential', 'purpose'];
const EXCEPTION_KEYS = ['name', 'home', 'consumer', 'credential', 'reason', 'until'];
// Client, tenant, app and account IDs, issuers, URLs and certificates are public configuration.
const PUBLIC_VALUE = /_(?:ID|ISSUER|URL|CERT|CERTIFICATE)$/;
const UPPER_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const LABEL = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const ENVIRONMENT_CONSUMER = /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+):([a-z0-9-]+)$/;
const SCRIPT_CONSUMER = /^[a-z]+(?::[a-z0-9-]+)+$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const credentialPattern = (provider) => new RegExp(`^wg-${provider}-[a-z0-9]+(?:-[a-z0-9]+)*$`);

function closed(failures, label, value, keys) {
  if (!isObject(value)) {
    failures.push(`${label} must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) if (!keys.includes(key)) failures.push(`${label}: unknown key ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) failures.push(`${label}: missing key ${key}`);
  return true;
}

// <PROVIDER>_<PURPOSE>_<KIND>, or <PURPOSE>_<KIND> without a prefix; a webhook secret's KIND already names its purpose.
function secretNameFailures(name, prefix) {
  const head = prefix ? `${prefix}((?:_[A-Z0-9]+)*?)` : '([A-Z0-9]+(?:_[A-Z0-9]+)*?)';
  const match = new RegExp(`^${head}_(${SECRET_KINDS.join('|')})$`).exec(name);
  if (match && (match[1] || match[2] === 'WEBHOOK_SECRET')) return [];
  return [`${name} must be named ${prefix ? `${prefix}_` : ''}<PURPOSE>_<KIND> with KIND one of ${SECRET_KINDS.join(', ')}`];
}

function validateName(failures, label, entry) {
  const { name, kind, home, provider, credential } = entry;
  if (typeof name !== 'string') return failures.push(`${label}: name must be a string`);
  if (kind === 'derived') {
    if (!LABEL.test(name)) failures.push(`${label}: derived key ${name} must be a lowercase hyphenated label`);
    if (entry.source !== DERIVED_SOURCE) failures.push(`${label}: derived key ${name} must name ${DERIVED_SOURCE} as its source`);
    if (home !== 'secrets-store' || provider !== 'wizardgang') failures.push(`${label}: derived key ${name} is a wizardgang secrets-store key`);
    return;
  }
  if (WRANGLER_GITHUB_NAMES.includes(name) && home !== 'github-environment') {
    failures.push(`${label}: ${name} is wrangler's GitHub name and lives only in GitHub environments`);
  }
  if (kind === 'secret' && home === 'keychain') {
    if (name !== credential) failures.push(`${label}: a keychain item is named after its console credential`);
    return;
  }
  if (!UPPER_NAME.test(name)) return failures.push(`${label}: ${name} must be an upper-case name`);
  if (home === 'github-environment' && name.startsWith(GITHUB_RESERVED_PREFIX)) {
    failures.push(`${label}: ${name} starts with ${GITHUB_RESERVED_PREFIX}, which GitHub reserves for Actions secrets and variables`);
  }
  const prefix = dropsProviderPrefix(entry) ? '' : PROVIDERS[provider];
  if (prefix === undefined) return;
  if (prefix && !name.startsWith(`${prefix}_`)) failures.push(`${label}: ${name} must start with ${prefix}_ for provider ${provider}`);
  if (kind === 'variable') {
    if (!['worker', 'github-environment'].includes(home)) failures.push(`${label}: variable ${name} lives in a Worker or a GitHub environment`);
    if (SECRET_KINDS.some((suffix) => name.endsWith(`_${suffix}`))) failures.push(`${label}: ${name} names secret material and must be a secret`);
    return;
  }
  if (kind !== 'secret') return;
  if (PUBLIC_VALUE.test(name)) return failures.push(`${label}: ${name} is public configuration and must be a variable, never a secret`);
  for (const failure of secretNameFailures(name, prefix)) failures.push(`${label}: ${failure}`);
  if (home === 'secrets-store' && provider !== 'wizardgang') failures.push(`${label}: the Secrets Store holds only shared WG_ platform secrets`);
  if (provider === 'wizardgang' && home !== 'secrets-store') failures.push(`${label}: shared WG_ platform secret ${name} lives only in the Secrets Store`);
}

function validateConsumers(failures, label, home, consumers) {
  if (!Array.isArray(consumers) || !consumers.length) return failures.push(`${label}: consumers must be a non-empty list`);
  const seen = new Set();
  for (const consumer of consumers) {
    if (typeof consumer !== 'string') {
      failures.push(`${label}: consumers must be strings`);
      continue;
    }
    if (seen.has(consumer)) failures.push(`${label}: duplicate consumer ${consumer}`);
    seen.add(consumer);
    if (home === 'worker' || home === 'secrets-store') {
      if (!WORKERS.includes(consumer)) failures.push(`${label}: consumer ${consumer} is not a declared Worker label`);
    } else if (home === 'github-environment') {
      if (REPOSITORY.test(consumer)) failures.push(`${label}: ${consumer} is a repository-level GitHub secret; Actions secrets live only in environments`);
      else if (!ENVIRONMENT_CONSUMER.test(consumer)) failures.push(`${label}: consumer ${consumer} must be owner/repository:environment`);
    } else if (home === 'keychain' && !SCRIPT_CONSUMER.test(consumer)) {
      failures.push(`${label}: keychain consumer ${consumer} must be a package script name`);
    }
  }
}

function validateEntry(failures, entry, index, names, credentials) {
  const label = `entries[${index}]`;
  const keys = entry?.kind === 'derived' ? [...ENTRY_KEYS, 'source'] : ENTRY_KEYS;
  if (!closed(failures, label, entry, keys)) return;
  const { name, kind, home, provider, credential } = entry;
  if (!KINDS.includes(kind)) failures.push(`${label}: kind must be one of ${KINDS.join(', ')}`);
  if (home === 'github-repository') failures.push(`${label}: repository-level GitHub secrets are not allowed; use a GitHub environment`);
  else if (!HOMES.includes(home)) failures.push(`${label}: home must be one of ${HOMES.join(', ')}`);
  if (!Object.hasOwn(PROVIDERS, provider)) failures.push(`${label}: provider must be one of ${Object.keys(PROVIDERS).join(', ')}`);
  if (!isText(entry.purpose)) failures.push(`${label}: purpose must be a short description`);
  validateName(failures, label, entry);
  validateConsumers(failures, label, home, entry.consumers);

  if (credential !== null) {
    if (kind !== 'secret') failures.push(`${label}: only a secret has a console credential`);
    else if (typeof credential !== 'string' || !credentialPattern(provider).test(credential)) {
      failures.push(`${label}: console credential must be named wg-${provider}-<purpose>`);
    }
  }
  if (typeof name !== 'string') return;
  const key = `${home}:${name}`;
  if (names.has(key)) failures.push(`${label}: duplicate name ${name} in home ${home}`);
  names.set(key, entry);
  if (typeof credential === 'string') {
    const canonical = canonicalName(entry);
    if (credentials.has(credential) && credentials.get(credential) !== canonical) {
      failures.push(`${label}: console credential ${credential} maps to both ${credentials.get(credential)} and ${canonical}`);
    }
    credentials.set(credential, canonical);
  }
}

function validateException(failures, exception, index, names, credentials) {
  const label = `exceptions[${index}]`;
  if (!closed(failures, label, exception, EXCEPTION_KEYS)) return;
  const entry = names.get(`${exception.home}:${exception.name}`);
  if (!entry || entry.kind !== 'secret' || typeof entry.credential !== 'string') {
    return failures.push(`${label}: must name a registered secret with a console credential in the same home`);
  }
  if (!entry.consumers.includes(exception.consumer)) failures.push(`${label}: consumer ${exception.consumer} does not use ${entry.name}`);
  if (typeof exception.credential !== 'string' || !credentialPattern(entry.provider).test(exception.credential)) {
    failures.push(`${label}: console credential must be named wg-${entry.provider}-<purpose>`);
  } else if (credentials.has(exception.credential)) {
    failures.push(`${label}: console credential ${exception.credential} is already registered`);
  } else {
    credentials.set(exception.credential, entry.name);
  }
  if (!isText(exception.reason)) failures.push(`${label}: reason must be a short description`);
  if (!isText(exception.until)) failures.push(`${label}: until must state the end condition`);
}

export function validateSecretRegistry(registry) {
  const failures = [];
  scanForCommittedValues(registry, 'secrets', failures);
  if (!closed(failures, 'secrets', registry, TOP_LEVEL_KEYS)) return failures;
  if (registry.schemaVersion !== 1) failures.push('secrets: schemaVersion must be 1');
  if (!Array.isArray(registry.entries) || !registry.entries.length) return [...failures, 'secrets: entries must be a non-empty list'];
  const names = new Map();
  const credentials = new Map();
  const byName = new Map();
  registry.entries.forEach((entry, index) => {
    validateEntry(failures, entry, index, names, credentials);
    if (entry?.credential == null || typeof entry.name !== 'string') return;
    const canonical = canonicalName(entry);
    if (byName.has(canonical) && byName.get(canonical) !== entry.credential) {
      failures.push(`entries[${index}]: ${canonical} maps to more than one console credential`);
    }
    byName.set(canonical, entry.credential);
  });
  if (!Array.isArray(registry.exceptions)) failures.push('secrets: exceptions must be a list');
  else registry.exceptions.forEach((exception, index) => validateException(failures, exception, index, names, credentials));
  return failures;
}

const sorted = (values) => [...new Set(values)].sort();

function requireSame(failures, label, declared, registered) {
  for (const name of declared) if (!registered.includes(name)) failures.push(`${label}: ${name} is not in the registry`);
  for (const name of registered) if (!declared.includes(name)) failures.push(`${label}: registry secret ${name} is missing`);
}

// The registry and config/cloudflare.json must agree on every Worker secret, the Secrets Store and the deploying
// environments; keychain consumers must be package scripts.
export function crossCheckSecretRegistry(registry, cloudflare, scripts = {}) {
  const failures = [];
  const entries = Array.isArray(registry?.entries) ? registry.entries.filter(isObject) : [];
  const secrets = (home) => entries.filter((entry) => entry.kind === 'secret' && entry.home === home);
  const consumers = (entry) => (Array.isArray(entry.consumers) ? entry.consumers : []);
  const workers = isObject(cloudflare?.workers) ? cloudflare.workers : {};
  for (const [label, worker] of Object.entries(workers)) {
    const registered = sorted(secrets('worker').filter((entry) => consumers(entry).includes(label)).map((entry) => entry.name));
    requireSame(failures, `config/cloudflare.json workers.${label}.secrets`, sorted(worker?.secrets ?? []), registered);
  }
  const stores = Array.isArray(cloudflare?.secretsStore) ? cloudflare.secretsStore : [];
  requireSame(failures, 'config/cloudflare.json secretsStore', sorted(stores.flatMap((store) => store?.secrets ?? [])),
    sorted(secrets('secrets-store').map((entry) => entry.name)));

  const deploying = sorted(Object.values(workers).map((worker) => `${worker?.repository}:${worker?.environment}`));
  const repositories = new Set(Object.values(workers).map((worker) => worker?.repository));
  for (const entry of entries.filter((candidate) => candidate.home === 'github-environment')) {
    for (const consumer of consumers(entry)) {
      const repository = ENVIRONMENT_CONSUMER.exec(consumer)?.[1];
      if (repository && !repositories.has(repository)) failures.push(`${entry.name}: ${repository} is not a config/cloudflare.json repository`);
    }
    if (WRANGLER_GITHUB_NAMES.includes(entry.name) && sorted(consumers(entry)).join() !== deploying.join()) {
      failures.push(`${entry.name}: consumers must be exactly the deploying environments ${deploying.join(', ')}`);
    }
  }
  for (const entry of entries.filter((candidate) => candidate.home === 'keychain')) {
    for (const consumer of consumers(entry)) if (!Object.hasOwn(scripts, consumer)) failures.push(`${entry.name}: ${consumer} is not a package script`);
  }
  return failures;
}

export function validateSecretRegistryAt(root) {
  const registry = loadSecretRegistry(root);
  const cloudflare = JSON.parse(readFileSync(join(root, 'config/cloudflare.json'), 'utf8'));
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const failures = validateSecretRegistry(registry);
  return failures.length ? failures : crossCheckSecretRegistry(registry, cloudflare, scripts);
}

export function loadSecretRegistry(root) {
  return JSON.parse(readFileSync(join(root, 'config/secrets.json'), 'utf8'));
}
