// The Worker settings a consumer's wrangler config must match, mirrored from baseline config/cloudflare.json.
// Consumers vendor platform/ without that file, so the policy is code; a baseline test fails if the two differ.

const worker = (host, aliases, durableObjects, crons, secrets = []) => Object.freeze({
  host,
  aliases: Object.freeze(aliases),
  durableObjects: Object.freeze(durableObjects),
  crons: Object.freeze(crons),
  secrets: Object.freeze(secrets),
});

// Worker secret names: the checker refuses them as plain-text vars.
const DEMO_SECRETS = [
  'CLOUDFLARE_API_TOKEN', 'DEMO_SESSION_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_DEMO_TOKEN',
  'GITHUB_READ_TOKEN', 'GITHUB_REPORTING_WRITE_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  'IDENTITY_AUDIT_HMAC_SECRET', 'IDENTITY_SESSION_SECRET', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_TENANT_ID', 'SAML_IDP_CERT', 'WEBHOOK_DEMO_SECRET',
];

export const DESIRED = Object.freeze({
  compatibility: Object.freeze({ date: '2026-08-31', flags: Object.freeze(['nodejs_compat']) }),
  workerSettings: Object.freeze({ observability: true, workersDev: false, previewUrls: false }),
  d1: Object.freeze({ binding: 'WG_DB', name: 'wizardgang' }),
  r2: Object.freeze({ binding: 'WG_R2', name: 'wizardgang' }),
  secretsStoreSecrets: Object.freeze(['WG_OPS_TOKEN', 'WG_SESSION_KEY']),
  workers: Object.freeze({
    wizardgang: worker('wizardgang.ai', ['www.wizardgang.ai'], [], []),
    demo: worker('demo.wizardgang.ai', [], ['DemoCoordinator'], ['*/5 * * * *'], DEMO_SECRETS),
    sharktank: worker('sharktank.wizardgang.ai', [], ['Room'], []),
    hexframe: worker('hexframe.wizardgang.ai', [], [], []),
  }),
});
