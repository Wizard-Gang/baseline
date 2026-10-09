# Cloudflare provider runbook

The owner performs every Cloudflare and GitHub secret mutation for the `wizardgang.ai` consolidation from this runbook, on the Mac. No agent, workflow or `npm run check` runs these steps. [`config/cloudflare.json`](../config/cloudflare.json) is the desired state. `npm run verify:cloudflare` is the read-only comparison, and the recorded account in [`tests/fixtures/cloudflare-2026-10-03.json`](../tests/fixtures/cloudflare-2026-10-03.json) is the starting inventory (18 missing, 38 unexpected and 4 mismatched items). This runbook names nothing else. It never holds a token value or the account ID. Credentials themselves (mint, set, rotate and revoke) are in [the secrets runbook](SECRETS-RUNBOOK.md).

Each step has four parts. **Precondition** is a fresh read-only check, run immediately before the step. **Command** is the exact mutation. **Read-back** proves the result. **Rollback** undoes it or says plainly that it cannot be undone. If a precondition does not hold, stop. Change nothing, re-read, and fix this runbook through a controlled change before going on.

**Phases.** Phase 1 deletes orphans. Phase 2 is baseline's tooling, which is done. Phase 3 provisions the shared resources. Phase 4 is each consuming repository's own migration, queued in its own plan. The later retirements are gated on Phase 4.

## Commands

Every command here is self-contained, because each terminal run starts a fresh shell: nothing is exported, and no function or variable survives from one command to the next. A command that needs the account ID reads it inline from the owner's wrangler login (`npx --yes wrangler@4.147.0 whoami --json`) into a shell variable and never prints it. A command that reads Cloudflare with the read-only audit token takes it from the macOS keychain item `wg-cloudflare-audit` (step 3.1) and passes it on stdin as a header, never as an argument.

- **Once per Mac:** `npx --yes wrangler@4.147.0 login`. Wrangler mutates with that OAuth login, so the shell must not export a Cloudflare token: `env | grep -c '^CLOUDFLARE_API_TOKEN='` prints 0. Run `npx --yes wrangler@4.147.0 whoami` again when a command reports an expired login. GitHub reads and writes use the owner's authenticated `gh`; check it with `gh auth status`.
- The baseline checkout at `~/Documents/GitHub/baseline` is on current `main` (`git -C ~/Documents/GitHub/baseline pull --ff-only`). Commands that run baseline scripts `cd` into it first.
- **Drift read** exits 0 when converged, 1 on drift (expected until Phase 4 is done), 2 for missing credentials, 3 for denied reads and 4 for anything else. Treat 2, 3 and 4 as a failed precondition.

  ```sh
  cd ~/Documents/GitHub/baseline && CLOUDFLARE_ACCOUNT_ID="$(npx --yes wrangler@4.147.0 whoami --json | jq -r '.accounts[0].id')" CLOUDFLARE_API_TOKEN="$(security find-generic-password -s wg-cloudflare-audit -w)" npm run --silent verify:cloudflare
  ```

- **Domain read** prints `<host> <Worker>` for every custom domain:

  ```sh
  A="$(npx --yes wrangler@4.147.0 whoami --json | jq -r '.accounts[0].id')"; security find-generic-password -s wg-cloudflare-audit -w | sed 's/^/Authorization: Bearer /' | curl -fsS -H @- "https://api.cloudflare.com/client/v4/accounts/$A/workers/domains" | jq -r '.result[] | "\(.hostname) \(.service)"'
  ```

- **Binding read** prints `<Worker> <type> <binding> <target>` for every binding of every Worker:

  ```sh
  A="$(npx --yes wrangler@4.147.0 whoami --json | jq -r '.accounts[0].id')"; get() { security find-generic-password -s wg-cloudflare-audit -w | sed 's/^/Authorization: Bearer /' | curl -fsS -H @- "https://api.cloudflare.com/client/v4/accounts/$A$1"; }; get /workers/scripts | jq -r '.result[].id' | while read -r w; do get "/workers/scripts/$w/settings" | jq -r --arg w "$w" '.result.bindings[] | "\($w) \(.type) \(.name) \(.database_id // .bucket_name // .namespace_id // .class_name // "")"'; done
  ```

"`<read> | grep -F <name>` prints nothing" means: run that read with `| grep -F <name>` appended, and expect no output.

**Run step 3.1 first.** The audit token is read-only, and every other precondition reads with it.

## Phase 1: delete orphans

None of these is bound by any Worker or served by any host. Phase 1 may run at any time and in any order after step 3.1.

### 1.1 Worker `wizardgang-portfolio-staging`

- **Precondition:** The drift read lists `- Worker wizardgang-portfolio-staging` under Unexpected. The domain read and the binding read, each piped to `grep -F wizardgang-portfolio-staging`, print nothing. Note the deployed version from `npx --yes wrangler@4.147.0 deployments list --name wizardgang-portfolio-staging`.
- **Command:** `npx --yes wrangler@4.147.0 delete wizardgang-portfolio-staging` (without `--force`; stop if it reports dependent Workers).
- **Read-back:** The drift read no longer lists it, and Unexpected drops by one.
- **Rollback:** Deleting a Worker cannot be undone. It served only workers.dev, from a `Wizard-Gang/WizardGang` commit. If it is ever needed, redeploy that commit under the same name from a WizardGang checkout.

### 1.2 D1 database `wizardgang-demo-data`

- **Precondition:** The drift read lists `- D1 database wizardgang-demo-data` under Unexpected. `npx --yes wrangler@4.147.0 d1 info wizardgang-demo-data --json` reports no tables. The binding read piped to `grep -F <its uuid>` prints nothing.
- **Command:** `npx --yes wrangler@4.147.0 d1 delete wizardgang-demo-data`
- **Read-back:** The drift read no longer lists it, and `npx --yes wrangler@4.147.0 d1 list` does not show it.
- **Rollback:** `npx --yes wrangler@4.147.0 d1 create wizardgang-demo-data` recreates it empty under a new UUID. Nothing bound the old UUID.

### 1.3 R2 bucket `wizardgang-demo-r2-preview`

- **Precondition:** The drift read lists `- R2 bucket wizardgang-demo-r2-preview` under Unexpected. `npx --yes wrangler@4.147.0 r2 bucket info wizardgang-demo-r2-preview` reports 0 objects. The binding read piped to `grep -F wizardgang-demo-r2-preview` prints nothing.
- **Command:** `npx --yes wrangler@4.147.0 r2 bucket delete wizardgang-demo-r2-preview`
- **Read-back:** The drift read no longer lists it, and `npx --yes wrangler@4.147.0 r2 bucket list` does not show it.
- **Rollback:** `npx --yes wrangler@4.147.0 r2 bucket create wizardgang-demo-r2-preview` recreates it empty.

### 1.4 KV namespaces `wg-gateway-status-dev` and `wg-gateway-status-prod`

- **Precondition:** The drift read lists `- KV namespace wg-gateway-status-dev` and `- KV namespace wg-gateway-status-prod` under Unexpected. `npx --yes wrangler@4.147.0 kv namespace list` shows their IDs, and the binding read piped to `grep -F <id>` prints nothing for either.
- **Command:** `npx --yes wrangler@4.147.0 kv namespace delete wg-gateway-status-dev`, then `npx --yes wrangler@4.147.0 kv namespace delete wg-gateway-status-prod`
- **Read-back:** The drift read lists neither, and Unexpected drops by two.
- **Rollback:** `npx --yes wrangler@4.147.0 kv namespace create <name>` recreates each one empty under a new ID. Its keys were August status leftovers that nothing reads, and they are not restored.

### 1.5 Hexframe `ADMIN_*` Worker secrets

- **Precondition:** The drift read lists `- Worker secret hexframe:ADMIN_PASSWORD`, `hexframe:ADMIN_SESSION_SECRET` and `hexframe:ADMIN_USERNAME` under Unexpected. Prove that the Worker source of neither `origin/main` nor the deployed commit reads them; the grep is scoped to `src`, so test strings elsewhere in the repository never match. Both greps must print nothing:

  ```sh
  git -C ~/Documents/GitHub/Hexframe fetch -q origin && git -C ~/Documents/GitHub/Hexframe grep -nE "(env|bindings)(\.|\[['\"])ADMIN_" origin/main -- src
  git -C ~/Documents/GitHub/Hexframe grep -nE "(env|bindings)(\.|\[['\"])ADMIN_" "$(curl -fsS https://hexframe.wizardgang.ai/version.json | jq -r .commit)" -- src
  ```

- **Command:** `for s in ADMIN_PASSWORD ADMIN_SESSION_SECRET ADMIN_USERNAME; do npx --yes wrangler@4.147.0 secret delete "$s" --name hexframe; done`. Each delete deploys a new version of the current Hexframe code without that secret.
- **Read-back:** The drift read lists no `hexframe:ADMIN_*` secret, and `npx --yes wrangler@4.147.0 secret list --name hexframe` is empty. `https://hexframe.wizardgang.ai/version.json` still reports the same commit.
- **Rollback:** If a reader ever reappears, `npx --yes wrangler@4.147.0 secret put <name> --name hexframe` sets the secret again from the owner's password manager, at the hidden prompt.

## Phase 3: provision the shared resources

Run these in order. Step 3.1 runs before Phase 1. Steps 3.2 to 3.6 run after Phase 1 and before any consumer's Phase 4 deploy, because `deploy-worker.yml` never creates a resource.

### 3.1 Mint the read-only audit token for `verify:cloudflare`

- **Precondition:** `npx --yes wrangler@4.147.0 whoami` shows the owner's account. `security find-generic-password -s wg-cloudflare-audit` reports that the item does not exist.
- **Command:** In the dashboard, under Manage Account → Account API Tokens, create the custom account-owned token `wg-cloudflare-audit` with these permissions only, all **Read**: Workers Scripts, D1, Workers R2 Storage, Workers KV Storage and Secrets Store. Give it no Edit permission and no zone permission. Copy the value once, then store it at the hidden prompt (the value is typed, never passed as an argument):

  ```sh
  security add-generic-password -a "$USER" -s wg-cloudflare-audit -w
  ```

- **Read-back:** The drift read exits 0 or 1, never 2 or 3. The verify call below prints `active`. The dashboard lists only Read permissions for it.

  ```sh
  A="$(npx --yes wrangler@4.147.0 whoami --json | jq -r '.accounts[0].id')"; security find-generic-password -s wg-cloudflare-audit -w | sed 's/^/Authorization: Bearer /' | curl -fsS -H @- "https://api.cloudflare.com/client/v4/accounts/$A/tokens/verify" | jq -r .result.status
  ```

- **Rollback:** Revoke the token in the dashboard, then run `security delete-generic-password -s wg-cloudflare-audit`.

### 3.2 Create D1 `wizardgang` and record its `database_id`

- **Precondition:** The drift read lists `- D1 database wizardgang` under Missing, and `npx --yes wrangler@4.147.0 d1 list` does not show it.
- **Command:** `npx --yes wrangler@4.147.0 d1 create wizardgang`
- **Read-back:** The drift read no longer lists it as missing. `npx --yes wrangler@4.147.0 d1 info wizardgang --json | jq -r .uuid` prints the UUID. Record it in the owner's password-manager note for the consolidation as the D1 `wizardgang` `database_id`. Each consumer commits it as the `database_id` of its `WG_DB` binding in `wrangler.jsonc` during Phase 4. Baseline never commits it, and a name-only binding fails the deploy, because `deploy-worker.yml` turns provisioning off.
- **Rollback:** While no consumer has committed the UUID and the database is empty, run `npx --yes wrangler@4.147.0 d1 delete wizardgang`.

### 3.3 Apply `0001_universal.sql`

- **Precondition:** `cd ~/Documents/GitHub/baseline && npm run check` passes on current `main`, which proves that [`platform/migrations/0001_universal.sql`](../platform/migrations/0001_universal.sql) matches its pin in [`pins.json`](../platform/migrations/pins.json). The database holds no schema: the query below returns no rows. Note the bookmark from `npx --yes wrangler@4.147.0 d1 time-travel info wizardgang --json | jq -r .bookmark`.

  ```sh
  npx --yes wrangler@4.147.0 d1 execute wizardgang --remote --json --command "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
  ```

- **Command:** `cd ~/Documents/GitHub/baseline && npx --yes wrangler@4.147.0 d1 execute wizardgang --remote --file platform/migrations/0001_universal.sql`
- **Read-back:** The same query returns exactly the tables `events` and `records` and the indexes `events_app_time`, `events_expiry`, `records_expiry` and `records_owner`. `npx --yes wrangler@4.147.0 d1 execute wizardgang --remote --command "SELECT count(*) FROM records"` returns 0.
- **Rollback:** Before any consumer writes, run `npx --yes wrangler@4.147.0 d1 time-travel restore wizardgang --bookmark <bookmark>`. A later migration is always the next `NNNN_name.sql` file, applied the same way after its own precondition. A merged migration is never edited or re-applied.

### 3.4 Create R2 `wizardgang` with its lifecycle rules

- **Precondition:** The drift read lists `- R2 bucket wizardgang` under Missing, and `npx --yes wrangler@4.147.0 r2 bucket list` does not show it.
- **Command:** Create the bucket, then replace Cloudflare's default 7-day multipart rule with the rules from `config/cloudflare.json`: abort incomplete multipart uploads after 1 day, and expire `demo/uploads/` after 1 day. Run the block as one command:

  ```sh
  npx --yes wrangler@4.147.0 r2 bucket create wizardgang && cat > "$TMPDIR/wizardgang-lifecycle.json" <<'JSON' && npx --yes wrangler@4.147.0 r2 bucket lifecycle set wizardgang --file "$TMPDIR/wizardgang-lifecycle.json"
  {"rules": [
    {"id": "abort-multipart-1d", "enabled": true, "conditions": {"prefix": ""},
     "abortMultipartUploadsTransition": {"condition": {"type": "Age", "maxAge": 86400}}},
    {"id": "demo-uploads-1d", "enabled": true, "conditions": {"prefix": "demo/uploads/"},
     "deleteObjectsTransition": {"condition": {"type": "Age", "maxAge": 86400}}}
  ]}
  JSON
  ```

- **Read-back:** `npx --yes wrangler@4.147.0 r2 bucket lifecycle list wizardgang` shows exactly those two rules. The drift read lists neither `R2 bucket wizardgang` nor any `R2 lifecycle rule wizardgang:` line.
- **Rollback:** To fix a rule, run `lifecycle set` again with a corrected file. While `npx --yes wrangler@4.147.0 r2 bucket info wizardgang` reports 0 objects, `npx --yes wrangler@4.147.0 r2 bucket delete wizardgang` removes the bucket.

### 3.5 Add `WG_OPS_TOKEN` and `WG_SESSION_KEY` to the Secrets Store

- **Precondition:** The drift read lists `- Secrets Store secret default_secrets_store:WG_OPS_TOKEN` and `default_secrets_store:WG_SESSION_KEY` under Missing. `npx --yes wrangler@4.147.0 secrets-store store list --remote` shows `default_secrets_store`. Consumers pass its ID to `render --store-id`, so record it next to the D1 UUID.
- **Command:** The block looks the store ID up with the audit token, generates each value locally and pipes it in. `wrangler` reads piped stdin, so no value appears in an argument or the history. Save the operator token from the clipboard into the password manager, then clear the clipboard with `pbcopy </dev/null`.

  ```sh
  A="$(npx --yes wrangler@4.147.0 whoami --json | jq -r '.accounts[0].id')"; S="$(security find-generic-password -s wg-cloudflare-audit -w | sed 's/^/Authorization: Bearer /' | curl -fsS -H @- "https://api.cloudflare.com/client/v4/accounts/$A/secrets_store/stores" | jq -r '.result[] | select(.name == "default_secrets_store") | .id')"
  v="$(openssl rand -hex 32)"; printf %s "$v" | pbcopy; printf %s "$v" | npx --yes wrangler@4.147.0 secrets-store secret create "$S" --name WG_OPS_TOKEN --scopes workers --remote; unset v
  openssl rand -hex 32 | npx --yes wrangler@4.147.0 secrets-store secret create "$S" --name WG_SESSION_KEY --scopes workers --remote
  ```

- **Read-back:** `npx --yes wrangler@4.147.0 secrets-store secret list <store id> --remote` shows both names, and the drift read no longer lists them.
- **Rollback:** While no Worker binds a secret, `npx --yes wrangler@4.147.0 secrets-store secret delete <store id> --secret-id <id from the list> --remote` removes it.

### 3.6 Mint the scoped deploy token and set it in every production environment

- **Precondition:** `cd ~/Documents/GitHub/baseline && npm run discover:cloudflare-token-targets` prints a `production` `CLOUDFLARE_API_TOKEN` line for each repository in `config/cloudflare.json`, with the console credential `wg-cloudflare-deploy` for every repository, and a `CLOUDFLARE_ACCOUNT_ID` variable line for each.
- **Command:** In the dashboard, under Account API Tokens, create the custom account-owned token `wg-cloudflare-deploy` with these minimum permissions:
  - Account: **Workers Scripts: Edit**. This covers uploading and deploying versions, static assets, Durable Object migrations, crons, Worker secrets, custom domains and `wrangler deployments status`.
  - Account: **Secrets Store: Edit**. Cloudflare treats binding a Secrets Store secret to a Worker as a write against the secret, so a token with only Read fails to deploy the `WG_OPS_TOKEN` and `WG_SESSION_KEY` bindings.
  - Zone `wizardgang.ai` only: **Workers Routes: Edit** and **Zone: Read**, for the custom domains.
  - Nothing else: no D1, R2 or KV edit, and no DNS, rulesets, API tokens, members or billing. If a deploy fails on a missing permission, add only the permission it names, and record the addition here through a controlled change.

  Copy the value, then run the plan, the rotation and the account ID variable writes. Rotation writes only the environments the registry maps to `wg-cloudflare-deploy`, and verifies the token against the account those environments' `CLOUDFLARE_ACCOUNT_ID` variables name.

  ```sh
  cd ~/Documents/GitHub/baseline && npm run rotate:cloudflare-token -- --credential wg-cloudflare-deploy
  cd ~/Documents/GitHub/baseline && pbpaste | npm run rotate:cloudflare-token -- --credential wg-cloudflare-deploy --apply; pbcopy </dev/null
  A="$(npx --yes wrangler@4.147.0 whoami --json | jq -r '.accounts[0].id')"; for r in Wizard-Gang/WizardGang Wizard-Gang/wizardgang-architecture-demo Wizard-Gang/SharkTank Wizard-Gang/Hexframe; do printf %s "$A" | gh variable set CLOUDFLARE_ACCOUNT_ID --repo "$r" --env production; done
  ```

- **Read-back:** Rotation prints `Cloudflare reports the token as active.`, a new `updatedAt` for every target and `Rotation of wg-cloudflare-deploy complete for all 4 target(s).`. `npm run discover:cloudflare-token-targets` then shows the new `updatedAt` on those four lines. It also shows an `updatedAt` on every `CLOUDFLARE_ACCOUNT_ID` variable line; a leftover `CLOUDFLARE_ACCOUNT_ID` secret is retired by R7.
- **Rollback:** GitHub secrets are write-only, so the old value cannot be restored. Keep superseded deploy tokens active until each repository has deployed with the new one, then revoke them in the dashboard. If the new token is wrong, fix its permissions, or roll it and pipe the new value through `rotate:cloudflare-token -- --credential wg-cloudflare-deploy --apply` again. `gh variable delete CLOUDFLARE_ACCOUNT_ID --repo <repository> --env production` removes a wrong account ID write.

## Phase 4 hand-off

Each consuming repository queues its own migration in its own plan. This runbook supplies the inputs and retires what the migrations leave behind. These are the owner's recorded defaults as of 2026-10-03; changing one is a controlled change to this runbook.

- **Inputs:** each consumer commits the D1 `wizardgang` UUID (3.2) and the Secrets Store ID (3.5) in the `wrangler.jsonc` that `node platform/conformance/cli.mjs render --worker <label> --store-id <id>` starts. Its `production` environment holds the secret `CLOUDFLARE_API_TOKEN` and the variable `CLOUDFLARE_ACCOUNT_ID` (3.6, R7).
- **Renames:** deploy the new label first. Move the custom domain at a release boundary, confirm `/version.json`, then retire the old name (R3).
- **SharkTank's `Room`:** it moves to `sharktank` by a `transferred_classes` migration, rehearsed first on a scratch Worker pair. If a live read at cut-over shows no stored state, a fresh class is an owner-approved fallback.
- **`www.wizardgang.ai`:** it becomes a custom domain on `wizardgang`, and the zone rule retires (R4).
- **Demo usage reporting:** it stays, reading the `wg-cloudflare-billing` token as the demo Worker secret `CLOUDFLARE_BILLING_TOKEN` ([secrets runbook](SECRETS-RUNBOOK.md), R5).

## Deploy rollback

A Worker is rolled back by redeploying its previous release tag through [`deploy-worker.yml`](../.github/workflows/deploy-worker.yml), never with `wrangler rollback` and never by moving a tag. See [`platform/deploy/README.md`](../platform/deploy/README.md).

- **Precondition:** `curl -fsS https://<host>/version.json` shows the bad version. `git -C ~/Documents/GitHub/<checkout> tag --sort=-v:refname | head -3` names the previous tag, which must be an annotated tag on `main`. Schema is never rolled back by a deploy: a release that needed a newer migration cannot go back past it.
- **Command:** Run the consumer's caller of `deploy-worker.yml` at the previous tag ref, for example `gh workflow run <caller workflow> --repo <repository> --ref <previous tag>`, so that the run is at that tag's commit, its reproduction job reproduces it, and it passes that tag and its commit. A dispatch from `main` naming an older tag fails the reproduction proof. Then run `gh run watch` on the new run.
- **Read-back:** The run's `verify` and `deploy` jobs pass, which proves 100% of traffic is on the new version and that its health and assets answer; the run's `result` output names the Worker version. `curl -fsS https://<host>/version.json` shows the previous tag's `version` and `commit`.
- **Rollback:** Redeploy the newer tag the same way.

## Later retirements

Each retirement waits for its gate, which a Phase 4 task in the owning repository satisfies; only R7's variable writes are ungated, and they run before the next `deploy-worker.yml` deploy. Check the gate again immediately before the command.

### R1 R2 bucket `wizardgang-demo-assets`, after SharkTank ST-148 is deployed

- **Precondition:** The deployed SharkTank commit contains ST-148; the check below succeeds. The binding read piped to `grep -F wizardgang-demo-assets` prints nothing. Download anything the owner wants to keep first.

  ```sh
  git -C ~/Documents/GitHub/SharkTank fetch -q origin && git -C ~/Documents/GitHub/SharkTank merge-base --is-ancestor "$(git -C ~/Documents/GitHub/SharkTank log origin/main --grep '^\[ST-148\]' --format=%H)" "$(curl -fsS https://sharktank.wizardgang.ai/version.json | jq -r .commit)"
  ```

- **Command:** `npx --yes wrangler@4.147.0 r2 bucket lifecycle add wizardgang-demo-assets expire-all "" --expire-days 1`. Once `npx --yes wrangler@4.147.0 r2 bucket info wizardgang-demo-assets` reports 0 objects, run `npx --yes wrangler@4.147.0 r2 bucket delete wizardgang-demo-assets`.
- **Read-back:** The drift read no longer lists `R2 bucket wizardgang-demo-assets`.
- **Rollback:** Until the objects expire, `npx --yes wrangler@4.147.0 r2 bucket lifecycle remove wizardgang-demo-assets --name expire-all` cancels it. After deletion, nothing can be restored.

### R2 D1 `demo-blob` and R2 `wizardgang-demo-r2`, after the demo's data migration

- **Precondition:** The demo's Phase 4 data migration is merged and deployed: `https://demo.wizardgang.ai/version.json` reports `app` `demo`, and its rows are in `records` and `events`. The binding read prints nothing for the `demo-blob` UUID (from `npx --yes wrangler@4.147.0 d1 info demo-blob --json`) or for `wizardgang-demo-r2`. This normally means R3 has retired `wizardgang-architecture-demo`.
- **Command:** `mkdir -p ~/wg-retired && npx --yes wrangler@4.147.0 d1 export demo-blob --remote --output ~/wg-retired/demo-blob-final.sql` (owner-local, never committed), then `npx --yes wrangler@4.147.0 d1 delete demo-blob`. For the bucket, run `npx --yes wrangler@4.147.0 r2 bucket lifecycle add wizardgang-demo-r2 expire-all "" --expire-days 1`. Once it reports 0 objects, run `npx --yes wrangler@4.147.0 r2 bucket delete wizardgang-demo-r2`.
- **Read-back:** The drift read lists neither `D1 database demo-blob` nor `R2 bucket wizardgang-demo-r2`.
- **Rollback:** `npx --yes wrangler@4.147.0 d1 create demo-blob`, then `npx --yes wrangler@4.147.0 d1 execute demo-blob --remote --file ~/wg-retired/demo-blob-final.sql`. The bucket can be saved only before its objects expire, with `lifecycle remove --name expire-all`.

### R3 Old Worker names, after each rename verifies

The pairs are `wizardgang-portfolio` → `wizardgang`, `wizardgang-architecture-demo` → `demo` and `wizardgangprod` → `sharktank`.

- **Precondition:** The drift read shows no `Worker <label>` under Missing and no custom domain mismatch for the label's host. `https://<host>/version.json` reports `app` `<label>` at its latest tag. The domain read piped to `grep -F <old>` prints nothing. For `wizardgangprod`, the drift read lists no `Durable Object wizardgangprod:` line, because the Room transfer is done and `Lobby` is deleted. Deleting a Worker deletes its Durable Object data.
- **Command:** `npx --yes wrangler@4.147.0 delete <old>` (without `--force`; stop if it reports dependent Workers).
- **Read-back:** The drift read lists no line for `<old>`: no Worker, Durable Object, cron or secret.
- **Rollback:** Before deletion, the rollback is moving the custom domain back to `<old>`. Deletion cannot be undone; after it, roll forward on the new name with a deploy rollback.

### R4 The `www` zone redirect rule, after the alias serves

- **Precondition:** The drift read lists no `custom domain www.wizardgang.ai → wizardgang` under Missing, and `https://wizardgang.ai/version.json` reports `app` `wizardgang`.
- **Command:** In the dashboard, open the zone's Rules, then **disable** the unmanaged rule that redirects `www.wizardgang.ai` to the apex. Delete it one release later.
- **Read-back:** `curl -sI 'https://www.wizardgang.ai/runbook?check=1'` returns 308 to `https://wizardgang.ai/runbook?check=1` with the shell's `content-security-policy` and `cache-control: no-store` headers, so the Worker answered, not the zone rule.
- **Rollback:** Re-enable the rule (until it is deleted).

### R5 The demo's old runtime token, after its replacement serves

- **Precondition:** The drift read lists no `Worker secret demo:CLOUDFLARE_BILLING_TOKEN` under Missing and no `wizardgang-architecture-demo` line. The `wg-cloudflare-billing` token is the `demo` Worker's `CLOUDFLARE_BILLING_TOKEN`, and the demo's usage reporting works with it. Any older reporting token is identified in the dashboard by its name and last-used date. If it cannot be told apart from another token, stop.
- **Command:** Revoke the old token in the dashboard.
- **Read-back:** The dashboard no longer lists it, and the demo's usage reporting still works.
- **Rollback:** None for a revoked token. If the replacement fails, roll `wg-cloudflare-billing` and set it again from [the secrets runbook](SECRETS-RUNBOOK.md#wg-cloudflare-billing).

### R6 The demo's repository-level `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`

- **Precondition:** `gh secret list --repo Wizard-Gang/wizardgang-architecture-demo` shows both names at repository level. `gh secret list --repo Wizard-Gang/wizardgang-architecture-demo --env production` shows the environment's own `CLOUDFLARE_API_TOKEN`. The demo's only deploy job binds the `production` environment, which shadows both repository-level copies.
- **Command:** `gh secret delete CLOUDFLARE_API_TOKEN --repo Wizard-Gang/wizardgang-architecture-demo`, then `gh secret delete CLOUDFLARE_ACCOUNT_ID --repo Wizard-Gang/wizardgang-architecture-demo`
- **Read-back:** `gh secret list --repo Wizard-Gang/wizardgang-architecture-demo` shows neither name, and `cd ~/Documents/GitHub/baseline && npm run discover:cloudflare-token-targets` reports no repository-level secret for the demo.
- **Rollback:** None is needed, because the registry allows no repository-level secret. A workflow that still needs a value reads it from its `production` environment: the token through `rotate:cloudflare-token -- --credential wg-cloudflare-deploy --apply`, and the account ID as R7's variable.

### R7 `CLOUDFLARE_ACCOUNT_ID` from secret to variable, before the next `deploy-worker.yml` deploy

- **Precondition:** `cd ~/Documents/GitHub/baseline && npm run discover:cloudflare-token-targets` reports `stores CLOUDFLARE_ACCOUNT_ID as a secret` or `also holds CLOUDFLARE_ACCOUNT_ID as a secret` for the repository. `deploy-worker.yml` reads only `vars.CLOUDFLARE_ACCOUNT_ID`, so the variable must exist before any deploy through it. Delete the secret only once the repository's own workflows stop reading it: `git -C ~/Documents/GitHub/<checkout> fetch -q && git -C ~/Documents/GitHub/<checkout> grep -n "secrets.CLOUDFLARE_ACCOUNT_ID" origin/main -- .github/workflows` prints nothing. On 2026-10-04 the SharkTank, Hexframe and demo `deploy.yml` workflows still read it, and WizardGang's do not.
- **Command:** Set the variable in every repository first; it sits safely beside the secret, because GitHub keeps secrets and variables apart. Then, for each repository that passes the workflow check, run `gh secret delete CLOUDFLARE_ACCOUNT_ID --repo <repository> --env production`.

  ```sh
  A="$(npx --yes wrangler@4.147.0 whoami --json | jq -r '.accounts[0].id')"; for r in Wizard-Gang/WizardGang Wizard-Gang/wizardgang-architecture-demo Wizard-Gang/SharkTank Wizard-Gang/Hexframe; do printf %s "$A" | gh variable set CLOUDFLARE_ACCOUNT_ID --repo "$r" --env production; done
  ```

- **Read-back:** `cd ~/Documents/GitHub/baseline && npm run discover:cloudflare-token-targets` shows an `updatedAt` on every `CLOUDFLARE_ACCOUNT_ID` variable line. It reports `also holds CLOUDFLARE_ACCOUNT_ID as a secret` only for repositories whose secret is still pending deletion, and nothing about it once the secret is gone. `gh variable list --repo <repository> --env production` lists `CLOUDFLARE_ACCOUNT_ID`.
- **Rollback:** For a workflow that still reads the secret, restore it: `A="$(npx --yes wrangler@4.147.0 whoami --json | jq -r '.accounts[0].id')"; printf %s "$A" | gh secret set CLOUDFLARE_ACCOUNT_ID --repo <repository> --env production`. `gh variable delete CLOUDFLARE_ACCOUNT_ID --repo <repository> --env production` removes a wrong variable.
