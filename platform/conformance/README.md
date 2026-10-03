# conformance

Keeps each consumer's Worker config and vendored `platform/` from drifting away from baseline. It is dependency-free Node ESM. It uses only `node:` built-ins and reads no provider or network. Consumers run it in CI from their repository root.

## Vendoring

A consumer copies baseline `platform/` verbatim from a merged `main` commit. It commits the lock that baseline prints for that commit as `platform/vendor.lock.json`:

```sh
# in baseline
npm run vendor:lock -- <commit> > ../<consumer>/platform/vendor.lock.json
# in the consumer
node platform/conformance/cli.mjs pin
```

The lock holds `schemaVersion`, `source` (`Wizard-Gang/baseline`), the full source `commit` and a SHA-256 for every file under `platform/`. `pin` fails in any of these cases:

- an edited file;
- a missing pinned file;
- a file the lock does not pin, such as app code or a consumer migration;
- a symlink;
- a malformed lock.

Vendored files are never edited. To change one, change it in baseline and re-vendor from the new commit.

## Worker config

```sh
node platform/conformance/cli.mjs wrangler --worker <label> [wrangler.jsonc]
node platform/conformance/cli.mjs render --worker <label> --store-id <default_secrets_store id>
```

[`../wrangler.template.jsonc`](../wrangler.template.jsonc) is the conforming shape. `render` fills it in for one Worker, adding its declared Durable Objects (bound under their class names, with a first migration) and its crons. A Worker that already has Durable Object history keeps its own `migrations`; only their net result is checked. The checker compares the config with the Worker's entry in `desired.mjs`, which mirrors baseline `config/cloudflare.json` and is tested against it:

- **Top level only.** No `env` blocks, no `account_id` and no `route`. Only these keys are allowed: `$schema`, `name`, `main`, `compatibility_date`, `compatibility_flags`, `workers_dev`, `preview_urls`, `routes`, `observability`, `vars`, `assets`, `d1_databases`, `r2_buckets`, `durable_objects`, `migrations`, `triggers`, `secrets_store_secrets` and `upload_source_maps`.
- **Identity.** `name` is the Worker label, and `vars.WG_APP` equals it. No other `WG_*` var is allowed, and no declared secret name may be a var. Every var is a string.
- **Routes.** The declared host appears exactly once as a custom domain. The only other entries allowed are declared aliases (only `www.wizardgang.ai`, on `wizardgang`). No zone routes.
- **Settings.** `workers_dev: false`, `preview_urls: false` and `observability.enabled: true`. The shared `compatibility_date` and exactly the shared `compatibility_flags`.
- **Bindings.**
  - D1: at most one, `WG_DB` → `wizardgang`, resolved by name or with a UUID `database_id`, and no `migrations_dir`.
  - R2: at most one, `WG_R2` → `wizardgang`.
  - KV: none.
  - Durable Objects: bindings to exactly the declared classes, with no `script_name`. The net `migrations` (create, delete, rename, transfer) must leave exactly those classes.
  - Crons: `triggers.crons` exactly as declared.
  - Secrets Store: only `WG_OPS_TOKEN` and `WG_SESSION_KEY`, each with `secret_name` equal to its binding and a 32-hex `store_id`.
  - `assets` may bind only `ASSETS`. Any other binding key is refused as an unknown top-level key.

Exit codes are 0 for conformant, 1 for nonconformant and 2 for a usage error.
