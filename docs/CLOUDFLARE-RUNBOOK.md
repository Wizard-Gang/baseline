# Cloudflare provider runbook

The owner performs every Cloudflare and GitHub secret mutation for the `wizardgang.ai` consolidation from this runbook, on the Mac. No agent, workflow or `npm run check` runs these steps. [`config/cloudflare.json`](../config/cloudflare.json) is the desired state. `npm run verify:cloudflare` is the read-only comparison, and the recorded account in [`tests/fixtures/cloudflare-2026-10-03.json`](../tests/fixtures/cloudflare-2026-10-03.json) is the starting inventory (18 missing, 38 unexpected and 4 mismatched items). This runbook names nothing else. It never holds a token value or the account ID.

Each step has four parts. **Precondition** is a fresh read-only check, run immediately before the step. **Command** is the exact mutation. **Read-back** proves the result. **Rollback** undoes it or says plainly that it cannot be undone. If a precondition does not hold, stop. Change nothing, re-read, and fix this runbook through a controlled change before going on.

**Phases.** Phase 1 deletes orphans. Phase 2 is baseline's tooling, which is done. Phase 3 provisions the shared resources. Phase 4 is each consuming repository's own migration, queued in its own plan. The later retirements are gated on Phase 4.

## Session setup

Run once per terminal session, from the baseline checkout on current `main`:

```sh
cd ~/Documents/GitHub/baseline && git switch main && git pull --ff-only && npm ci
printf 'Cloudflare account ID: '; read -r CLOUDFLARE_ACCOUNT_ID; export CLOUDFLARE_ACCOUNT_ID
audit() { security find-generic-password -s wg-cloudflare-audit -w; }
cfverify() { CLOUDFLARE_API_TOKEN="$(audit)" npm run --silent verify:cloudflare; }
cfget() { printf 'Authorization: Bearer %s\n' "$(audit)" | curl -fsS -H @- "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID$1"; }
domains() { cfget /workers/domains | jq -r '.result[] | "\(.hostname) \(.service)"'; }
bindings() { cfget /workers/scripts | jq -r '.result[].id' | while read -r w; do cfget "/workers/scripts/$w/settings" | jq -r --arg w "$w" '.result.bindings[] | "\($w) \(.type) \(.name) \(.database_id // .bucket_name // .namespace_id // .class_name // "")"'; done; }
repos() { node -p "[...new Set(Object.values(require('./config/cloudflare.json').workers).map((w) => w.repository))].join('\n')"; }
wr() { env -u CLOUDFLARE_API_TOKEN npx --yes wrangler@4.147.0 "$@"; }
wr login && wr whoami
```

- The account ID is typed at runtime and never written to a file. `cfverify`, `cfget`, `domains` and `bindings` read with the read-only audit token from the macOS keychain (Phase 3, step 3.1), passed per command and never exported.
- `wr` mutates with the owner's wrangler OAuth login. It drops any `CLOUDFLARE_API_TOKEN`, so the read-only token can never be used by mistake. Run `wr whoami` again if a command reports an expired login.
- `cfverify` exits 0 when converged, 1 on drift (expected until Phase 4 is done), 2 for missing credentials, 3 for denied reads and 4 for anything else. Treat 2, 3 and 4 as a failed precondition.
- GitHub reads and writes use the owner's authenticated `gh`; check it with `gh auth status`.

**Run step 3.1 first.** The audit token is read-only, and every other precondition reads with it.

## Phase 1: delete orphans

None of these is bound by any Worker or served by any host. Phase 1 may run at any time and in any order after step 3.1.

### 1.1 Worker `wizardgang-portfolio-staging`

- **Precondition:** `cfverify` lists `- Worker wizardgang-portfolio-staging` under Unexpected. `domains | grep -F wizardgang-portfolio-staging` and `bindings | grep -F wizardgang-portfolio-staging` print nothing. Note the deployed version from `wr deployments list --name wizardgang-portfolio-staging`.
- **Command:** `wr delete wizardgang-portfolio-staging` (without `--force`; stop if it reports dependent Workers).
- **Read-back:** `cfverify` no longer lists it, and Unexpected drops by one.
- **Rollback:** Deleting a Worker cannot be undone. It served only workers.dev, from a `Wizard-Gang/WizardGang` commit. If it is ever needed, redeploy that commit under the same name from a WizardGang checkout.

### 1.2 D1 database `wizardgang-demo-data`

- **Precondition:** `cfverify` lists `- D1 database wizardgang-demo-data` under Unexpected. `wr d1 info wizardgang-demo-data --json` reports no tables. `bindings | grep -F <its uuid>` prints nothing.
- **Command:** `wr d1 delete wizardgang-demo-data`
- **Read-back:** `cfverify` no longer lists it, and `wr d1 list` does not show it.
- **Rollback:** `wr d1 create wizardgang-demo-data` recreates it empty under a new UUID. Nothing bound the old UUID.

### 1.3 R2 bucket `wizardgang-demo-r2-preview`

- **Precondition:** `cfverify` lists `- R2 bucket wizardgang-demo-r2-preview` under Unexpected. `wr r2 bucket info wizardgang-demo-r2-preview` reports 0 objects. `bindings | grep -F wizardgang-demo-r2-preview` prints nothing.
- **Command:** `wr r2 bucket delete wizardgang-demo-r2-preview`
- **Read-back:** `cfverify` no longer lists it, and `wr r2 bucket list` does not show it.
- **Rollback:** `wr r2 bucket create wizardgang-demo-r2-preview` recreates it empty.

### 1.4 KV namespaces `wg-gateway-status-dev` and `wg-gateway-status-prod`

- **Precondition:** `cfverify` lists `- KV namespace wg-gateway-status-dev` and `- KV namespace wg-gateway-status-prod` under Unexpected. `wr kv namespace list` shows their IDs, and `bindings | grep -F <id>` prints nothing for either.
- **Command:** `wr kv namespace delete wg-gateway-status-dev`, then `wr kv namespace delete wg-gateway-status-prod`
- **Read-back:** `cfverify` lists neither, and Unexpected drops by two.
- **Rollback:** `wr kv namespace create <name>` recreates each one empty under a new ID. Its keys were August status leftovers that nothing reads, and they are not restored.

### 1.5 Hexframe `ADMIN_*` Worker secrets

- **Precondition:** `cfverify` lists `- Worker secret hexframe:ADMIN_PASSWORD`, `hexframe:ADMIN_SESSION_SECRET` and `hexframe:ADMIN_USERNAME` under Unexpected. Prove that neither `origin/main` nor the deployed commit reads them. Both greps must print nothing:

  ```sh
  git -C ../Hexframe fetch origin
  git -C ../Hexframe grep -nE "(env|bindings)(\.|\[['\"])ADMIN_" origin/main
  git -C ../Hexframe grep -nE "(env|bindings)(\.|\[['\"])ADMIN_" "$(curl -fsS https://hexframe.wizardgang.ai/version.json | jq -r .commit)"
  ```

- **Command:** `for s in ADMIN_PASSWORD ADMIN_SESSION_SECRET ADMIN_USERNAME; do wr secret delete "$s" --name hexframe; done`. Each delete deploys a new version of the current Hexframe code without that secret.
- **Read-back:** `cfverify` lists no `hexframe:ADMIN_*` secret, and `wr secret list --name hexframe` is empty. `https://hexframe.wizardgang.ai/version.json` still reports the same commit.
- **Rollback:** If a reader ever reappears, `wr secret put <name> --name hexframe` sets the secret again from the owner's password manager, at the hidden prompt.

## Phase 3: provision the shared resources

Run these in order. Step 3.1 runs before Phase 1. Steps 3.2 to 3.6 run after Phase 1 and before any consumer's Phase 4 deploy, because `deploy-worker.yml` never creates a resource.

### 3.1 Mint the read-only audit token for `verify:cloudflare`

- **Precondition:** `wr whoami` shows the owner's account. `security find-generic-password -s wg-cloudflare-audit` reports that the item does not exist.
- **Command:** In the dashboard, under Manage Account → Account API Tokens, create a custom account-owned token with these permissions only, all **Read**: Workers Scripts, D1, Workers R2 Storage, Workers KV Storage and Secrets Store. Give it no Edit permission and no zone permission. Copy the value once, then store it at the hidden prompt (the value is typed, never passed as an argument):

  ```sh
  security add-generic-password -a "$USER" -s wg-cloudflare-audit -w
  ```

- **Read-back:** `cfverify` exits 0 or 1, never 2 or 3. `printf 'Authorization: Bearer %s\n' "$(audit)" | curl -fsS -H @- "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/verify" | jq -r .result.status` prints `active`. The dashboard lists only Read permissions for it.
- **Rollback:** Revoke the token in the dashboard, then run `security delete-generic-password -s wg-cloudflare-audit`.

### 3.2 Create D1 `wizardgang` and record its `database_id`

- **Precondition:** `cfverify` lists `- D1 database wizardgang` under Missing, and `wr d1 list` does not show it.
- **Command:** `wr d1 create wizardgang`
- **Read-back:** `cfverify` no longer lists it as missing. `wr d1 info wizardgang --json | jq -r .uuid` prints the UUID. Record it in the owner's password-manager note for the consolidation as the D1 `wizardgang` `database_id`. Each consumer commits it as the `database_id` of its `WG_DB` binding in `wrangler.jsonc` during Phase 4. Baseline never commits it, and a name-only binding fails the deploy, because `deploy-worker.yml` turns provisioning off.
- **Rollback:** While no consumer has committed the UUID and the database is empty, run `wr d1 delete wizardgang`.

### 3.3 Apply `0001_universal.sql`

- **Precondition:** `npm run check` passes on current `main`, which proves that [`platform/migrations/0001_universal.sql`](../platform/migrations/0001_universal.sql) matches its pin in [`pins.json`](../platform/migrations/pins.json). The database holds no schema: the query below returns no rows. Note the bookmark from `wr d1 time-travel info wizardgang --json | jq -r .bookmark`.

  ```sh
  wr d1 execute wizardgang --remote --json --command "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
  ```

- **Command:** `wr d1 execute wizardgang --remote --file platform/migrations/0001_universal.sql`
- **Read-back:** The same query returns exactly the tables `events` and `records` and the indexes `events_app_time`, `events_expiry`, `records_expiry` and `records_owner`. `wr d1 execute wizardgang --remote --command "SELECT count(*) FROM records"` returns 0.
- **Rollback:** Before any consumer writes, run `wr d1 time-travel restore wizardgang --bookmark <bookmark>`. A later migration is always the next `NNNN_name.sql` file, applied the same way after its own precondition. A merged migration is never edited or re-applied.

### 3.4 Create R2 `wizardgang` with its lifecycle rules

- **Precondition:** `cfverify` lists `- R2 bucket wizardgang` under Missing, and `wr r2 bucket list` does not show it.
- **Command:** Create the bucket, then replace Cloudflare's default 7-day multipart rule with the rules from `config/cloudflare.json`: abort incomplete multipart uploads after 1 day, and expire `demo/uploads/` after 1 day.

  ```sh
  wr r2 bucket create wizardgang
  cat > "$TMPDIR/wizardgang-lifecycle.json" <<'JSON'
  {"rules": [
    {"id": "abort-multipart-1d", "enabled": true, "conditions": {"prefix": ""},
     "abortMultipartUploadsTransition": {"condition": {"type": "Age", "maxAge": 86400}}},
    {"id": "demo-uploads-1d", "enabled": true, "conditions": {"prefix": "demo/uploads/"},
     "deleteObjectsTransition": {"condition": {"type": "Age", "maxAge": 86400}}}
  ]}
  JSON
  wr r2 bucket lifecycle set wizardgang --file "$TMPDIR/wizardgang-lifecycle.json"
  ```

- **Read-back:** `wr r2 bucket lifecycle list wizardgang` shows exactly those two rules. `cfverify` lists neither `R2 bucket wizardgang` nor any `R2 lifecycle rule wizardgang:` line.
- **Rollback:** To fix a rule, run `lifecycle set` again with a corrected file. While `wr r2 bucket info wizardgang` reports 0 objects, `wr r2 bucket delete wizardgang` removes the bucket.

### 3.5 Add `WG_OPS_TOKEN` and `WG_SESSION_KEY` to the Secrets Store

- **Precondition:** `cfverify` lists `- Secrets Store secret default_secrets_store:WG_OPS_TOKEN` and `default_secrets_store:WG_SESSION_KEY` under Missing. `wr secrets-store store list --remote` shows `default_secrets_store`. Set `STORE_ID` to its ID; consumers pass the same ID to `render --store-id`, so record it next to the D1 UUID.
- **Command:** Generate each value locally and pipe it in. `wrangler` reads piped stdin, so no value appears in an argument or the history. Save the operator token from the clipboard into the password manager, then clear the clipboard.

  ```sh
  v="$(openssl rand -hex 32)"; printf %s "$v" | pbcopy
  printf %s "$v" | wr secrets-store secret create "$STORE_ID" --name WG_OPS_TOKEN --scopes workers --remote; unset v
  openssl rand -hex 32 | wr secrets-store secret create "$STORE_ID" --name WG_SESSION_KEY --scopes workers --remote
  pbcopy </dev/null
  ```

- **Read-back:** `wr secrets-store secret list "$STORE_ID" --remote` shows both names, and `cfverify` no longer lists them.
- **Rollback:** While no Worker binds a secret, `wr secrets-store secret delete "$STORE_ID" --secret-id <id from the list> --remote` removes it.

### 3.6 Mint the scoped deploy token and set it in every production environment

- **Precondition:** `npm run discover:cloudflare-token-targets` prints one line for each repository in `config/cloudflare.json`. It exits 1, and its drift is only the demo's repository-level `CLOUDFLARE_API_TOKEN` and its empty `production` environment. `repos | while read -r r; do echo "== $r"; gh secret list --repo "$r" --env production; done` shows which environments already hold `CLOUDFLARE_ACCOUNT_ID`.
- **Command:** In the dashboard, under Account API Tokens, create a custom account-owned token with these minimum permissions:
  - Account: **Workers Scripts: Edit**. This covers uploading and deploying versions, static assets, Durable Object migrations, crons, Worker secrets, custom domains and `wrangler deployments status`.
  - Zone `wizardgang.ai` only: **Workers Routes: Edit** and **Zone: Read**, for the custom domains.
  - Nothing else: no D1, R2, KV or Secrets Store edit, and no DNS, rulesets, API tokens, members or billing. If a deploy fails on a missing permission, add only the permission it names, and record the addition here through a controlled change.

  Copy the value, then run the plan, the rotation and the account ID writes:

  ```sh
  npm run rotate:cloudflare-token
  pbpaste | npm run rotate:cloudflare-token -- --apply
  pbcopy </dev/null
  repos | while read -r r; do printf %s "$CLOUDFLARE_ACCOUNT_ID" | gh secret set CLOUDFLARE_ACCOUNT_ID --repo "$r" --env production; done
  ```

- **Read-back:** Rotation prints `Cloudflare reports the token as active.`, a new `updatedAt` for every target and `Rotation complete for all 4 target(s).`. `npm run discover:cloudflare-token-targets` then shows an `updatedAt` for all four. Its only drift is the demo's repository-level copy, which retirement R6 removes. The `gh secret list` loop shows `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in every `production` environment.
- **Rollback:** GitHub secrets are write-only, so the old value cannot be restored. Keep superseded deploy tokens active until each repository has deployed with the new one, then revoke them in the dashboard. If the new token is wrong, fix its permissions, or roll it and pipe the new value through `rotate:cloudflare-token -- --apply` again. `gh secret delete CLOUDFLARE_ACCOUNT_ID --repo <repository> --env production` removes a wrong account ID write.

## Phase 4 hand-off

Each consuming repository queues its own migration in its own plan. This runbook supplies the inputs and retires what the migrations leave behind. These are the owner's recorded defaults as of 2026-10-03; changing one is a controlled change to this runbook.

- **Inputs:** each consumer commits the D1 `wizardgang` UUID (3.2) and the Secrets Store ID (3.5) in the `wrangler.jsonc` that `node platform/conformance/cli.mjs render --worker <label> --store-id <id>` starts. Its `production` environment holds `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (3.6).
- **Renames:** deploy the new label first. Move the custom domain at a release boundary, confirm `/version.json`, then retire the old name (R3).
- **SharkTank's `Room`:** it moves to `sharktank` by a `transferred_classes` migration, rehearsed first on a scratch Worker pair. If a live read at cut-over shows no stored state, a fresh class is an owner-approved fallback.
- **`www.wizardgang.ai`:** it becomes a custom domain on `wizardgang`, and the zone rule retires (R4).
- **Demo usage reporting:** it stays, using a newly minted read-only token as the demo's `CLOUDFLARE_API_TOKEN` secret (R5).

## Deploy rollback

A Worker is rolled back by redeploying its previous release tag through [`deploy-worker.yml`](../.github/workflows/deploy-worker.yml), never with `wrangler rollback` and never by moving a tag. See [`platform/deploy/README.md`](../platform/deploy/README.md).

- **Precondition:** `curl -fsS https://<host>/version.json` shows the bad version. `git -C ../<repository> tag --sort=-v:refname | head -3` names the previous tag, which must be an annotated tag on `main`. Schema is never rolled back by a deploy: a release that needed a newer migration cannot go back past it.
- **Command:** Run the consumer's caller of `deploy-worker.yml` at the previous tag ref, for example `gh workflow run <caller workflow> --repo <repository> --ref <previous tag>`, so that it passes that tag and its commit. Then run `gh run watch` on the new run.
- **Read-back:** The run's `verify` and `deploy` jobs pass, which proves 100% of traffic is on the new version. `curl -fsS https://<host>/version.json` shows the previous tag's `version` and `commit`.
- **Rollback:** Redeploy the newer tag the same way.

## Later retirements

Each retirement waits for its gate, which a Phase 4 task in the owning repository satisfies. Check the gate again immediately before the command.

### R1 R2 bucket `wizardgang-demo-assets`, after SharkTank ST-148 is deployed

- **Precondition:** The deployed SharkTank commit contains ST-148: `git -C ../SharkTank merge-base --is-ancestor "$(git -C ../SharkTank log origin/main --grep '^\[ST-148\]' --format=%H)" "$(curl -fsS https://sharktank.wizardgang.ai/version.json | jq -r .commit)"` succeeds. `bindings | grep -F wizardgang-demo-assets` prints nothing. Download anything the owner wants to keep first.
- **Command:** `wr r2 bucket lifecycle add wizardgang-demo-assets expire-all "" --expire-days 1`. Once `wr r2 bucket info wizardgang-demo-assets` reports 0 objects, run `wr r2 bucket delete wizardgang-demo-assets`.
- **Read-back:** `cfverify` no longer lists `R2 bucket wizardgang-demo-assets`.
- **Rollback:** Until the objects expire, `wr r2 bucket lifecycle remove wizardgang-demo-assets --name expire-all` cancels it. After deletion, nothing can be restored.

### R2 D1 `demo-blob` and R2 `wizardgang-demo-r2`, after the demo's data migration

- **Precondition:** The demo's Phase 4 data migration is merged and deployed: `https://demo.wizardgang.ai/version.json` reports `app` `demo`, and its rows are in `records` and `events`. `bindings` prints nothing for the `demo-blob` UUID (from `wr d1 info demo-blob --json`) or for `wizardgang-demo-r2`. This normally means R3 has retired `wizardgang-architecture-demo`.
- **Command:** `mkdir -p ~/wg-retired && wr d1 export demo-blob --remote --output ~/wg-retired/demo-blob-final.sql` (owner-local, never committed), then `wr d1 delete demo-blob`. For the bucket, run `wr r2 bucket lifecycle add wizardgang-demo-r2 expire-all "" --expire-days 1`. Once it reports 0 objects, run `wr r2 bucket delete wizardgang-demo-r2`.
- **Read-back:** `cfverify` lists neither `D1 database demo-blob` nor `R2 bucket wizardgang-demo-r2`.
- **Rollback:** `wr d1 create demo-blob`, then `wr d1 execute demo-blob --remote --file ~/wg-retired/demo-blob-final.sql`. The bucket can be saved only before its objects expire, with `lifecycle remove --name expire-all`.

### R3 Old Worker names, after each rename verifies

The pairs are `wizardgang-portfolio` → `wizardgang`, `wizardgang-architecture-demo` → `demo` and `wizardgangprod` → `sharktank`.

- **Precondition:** `cfverify` shows no `Worker <label>` under Missing and no custom domain mismatch for the label's host. `https://<host>/version.json` reports `app` `<label>` at its latest tag. `domains | grep -F <old>` prints nothing. For `wizardgangprod`, `cfverify` lists no `Durable Object wizardgangprod:` line, because the Room transfer is done and `Lobby` is deleted. Deleting a Worker deletes its Durable Object data.
- **Command:** `wr delete <old>` (without `--force`; stop if it reports dependent Workers).
- **Read-back:** `cfverify` lists no line for `<old>`: no Worker, Durable Object, cron or secret.
- **Rollback:** Before deletion, the rollback is moving the custom domain back to `<old>`. Deletion cannot be undone; after it, roll forward on the new name with a deploy rollback.

### R4 The `www` zone redirect rule, after the alias serves

- **Precondition:** `cfverify` lists no `custom domain www.wizardgang.ai → wizardgang` under Missing, and `https://wizardgang.ai/version.json` reports `app` `wizardgang`.
- **Command:** In the dashboard, open the zone's Rules, then **disable** the unmanaged rule that redirects `www.wizardgang.ai` to the apex. Delete it one release later.
- **Read-back:** `curl -sI 'https://www.wizardgang.ai/runbook?check=1'` returns 308 to `https://wizardgang.ai/runbook?check=1` with the shell's `content-security-policy` and `cache-control: no-store` headers, so the Worker answered, not the zone rule.
- **Rollback:** Re-enable the rule (until it is deleted).

### R5 The demo's old runtime token, after its replacement serves

- **Precondition:** `cfverify` lists no `Worker secret demo:CLOUDFLARE_API_TOKEN` under Missing and no `wizardgang-architecture-demo` line. The newly minted read-only token is the `demo` Worker's `CLOUDFLARE_API_TOKEN`, and the demo's usage reporting works with it. The old token is identified in the dashboard by its name and last-used date. If it cannot be told apart from another token, stop.
- **Command:** Revoke the old token in the dashboard.
- **Read-back:** The dashboard no longer lists it, and the demo's usage reporting still works.
- **Rollback:** None for a revoked token. The read-only replacement is already the demo's secret; if it fails, mint another and run `wr secret put CLOUDFLARE_API_TOKEN --name demo`.

### R6 The demo's repository-level `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`

- **Precondition:** `gh secret list --repo SouthernGentlemen/wizardgang-architecture-demo --env production` shows both names. The demo's latest deploy ran through `deploy-worker.yml` and passed. `git -C ../wizardgang-architecture-demo grep -n "secrets.CLOUDFLARE_" origin/main -- .github/workflows` prints nothing, so no workflow reads the repository-level copies.
- **Command:** `gh secret delete CLOUDFLARE_API_TOKEN --repo SouthernGentlemen/wizardgang-architecture-demo`, then `gh secret delete CLOUDFLARE_ACCOUNT_ID --repo SouthernGentlemen/wizardgang-architecture-demo`
- **Read-back:** `gh secret list --repo SouthernGentlemen/wizardgang-architecture-demo` shows neither name, and `npm run discover:cloudflare-token-targets` exits 0.
- **Rollback:** `printf %s "$CLOUDFLARE_ACCOUNT_ID" | gh secret set CLOUDFLARE_ACCOUNT_ID --repo SouthernGentlemen/wizardgang-architecture-demo`, and the deploy token the same way from `pbpaste`.
