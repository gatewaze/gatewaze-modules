# Test stand-up — full pipeline on our own infra (no LF creds needed)

Goal: prove Supabase → Airbyte → Snowflake → STAGING end-to-end using a **free
Snowflake trial** as the destination and **Airbyte in the AAIF prod cluster**,
so that when the LF Snowflake is provisioned we just re-point the destination.

Nothing here touches the LF account. It DOES touch prod AAIF Supabase (a scoped
read-only role + a replication slot) and the prod cluster (a new namespace-local
service) — review each step before running.

> **Prerequisite (code):** STAGING can't run until the manifest is reconciled to
> the real schema and the generator can read jsonb (gaps G1–G3, `gap-analysis.md`).
> Steps 1–5 (RAW landing) work without it; do G1–G3 before step 6 (STAGING).

## 0. Two gotchas that fail the first attempt
- **Use the DIRECT endpoint, not the pooler.** `SUPABASE_DB_HOST` in
  `aaif.production.env` is the Supavisor pooler — replication slots can't run
  through it. Airbyte's source must use `db.ktkkanmhbygivyzzyfex.supabase.co:5432`
  (or Supavisor session mode). If cluster egress is IPv4-only, enable the Supabase
  IPv4 add-on.
- **`sslmode=verify-full`** on the source connection.

## 1. Free Snowflake trial
1. Sign up at signup.snowflake.com (Standard edition, pick AWS `us-west-1` to sit
   near the Supabase region). Note the **account identifier** (`org-account`).
2. As `ACCOUNTADMIN`, apply the module's reference objects — the Terraform in
   `snowflake/terraform/` provisions database `AAIF`, schemas
   `RAW/STAGING/MARTS/OPERATIONS`, warehouse `AAIF_LOADING_WH`, the roles, and
   `SVC_AAIF_CDC`. (On a trial you own ACCOUNTADMIN, so `terraform apply` works
   directly — no CloudOps needed.)
3. Generate a key-pair for `SVC_AAIF_CDC` and register the public key:
   ```bash
   openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out svc_aaif_cdc.p8 -nocrypt
   openssl rsa -in svc_aaif_cdc.p8 -pubout -out svc_aaif_cdc.pub
   # in Snowflake: ALTER USER SVC_AAIF_CDC SET RSA_PUBLIC_KEY='<pub body, no header>';
   ```

## 2. Source prerequisites on AAIF Supabase (scoped, reversible)
Apply the opt-in migration to create the reader + publication + slot:
```sql
SET warehouse_sync.apply_source_prereqs = 'on';
\i migrations/003_source_prerequisites.sql
ALTER ROLE snowflake_reader WITH PASSWORD '<generated, store in SOPS>';
-- confirm max_slot_wal_keep_size is bounded (§10.4 control #3)
SHOW max_slot_wal_keep_size;
```
> The publication table list in `003` must match the reconciled manifest (G1) —
> regenerate with `pnpm generate:sql` and diff before applying.

## 3. Deploy Airbyte in the AAIF cluster
Add a release to `k8s/helmfile.yaml.gotmpl` (values in `k8s/values-airbyte.yaml`):
```yaml
repositories:
  - name: airbyte
    url: https://airbytehq.github.io/helm-charts

releases:
  - name: airbyte
    namespace: gatewaze
    chart: airbyte/airbyte
    version: <pin latest 1.x>          # pin + verify values-airbyte.yaml keys
    values: [ values-airbyte.yaml ]
    wait: true
    timeout: 1200
```
Then `make deploy` (or `helmfile apply`). Reach the UI/API without ingress:
```bash
kubectl -n gatewaze port-forward svc/airbyte-airbyte-webapp-svc 8000:80
```

## 4. Configure the sync in Airbyte (AAIF workspace)
- **Source — Postgres (CDC):** host `db.ktkkanmhbygivyzzyfex.supabase.co`, port
  5432, user `snowflake_reader`, `sslmode=verify-full`; replication method **CDC**,
  publication `snowflake_cdc`, slot `snowflake_cdc`; streams = the allow-list
  tables (from the reconciled manifest).
- **Destination — Snowflake:** the trial account; database `AAIF`, schema `RAW`,
  warehouse `AAIF_LOADING_WH`; auth **key-pair** as `SVC_AAIF_CDC`; **Typing &
  Deduping ON** (lands `_ab_cdc_deleted_at` / `_ab_cdc_updated_at` — matches
  `AIRBYTE_RAW_META`).
- **Connection:** incremental + dedupe, ~5–15 min schedule.

## 5. Point the module at Airbyte
Set warehouse-sync config on AAIF:
```
mechanism           = airbyte
airbyteApiUrl       = http://airbyte-airbyte-server-svc.gatewaze:8001
airbyteWorkspaceId  = <AAIF workspace UUID>
replicationSlotName = snowflake_cdc
```
The slot-monitor now watches the Debezium slot; the airbyte-status worker + CDC
Health dashboard show the sync. **This alone proves RAW landing + slot safety.**

## 6. Build STAGING (after G1–G3)
```bash
pnpm --filter @gatewaze-modules/warehouse-sync generate:sql
# apply snowflake/staging/*.sql + snowflake/operations/*.sql to the trial account
```
Verify: `SELECT COUNT(*) FROM AAIF.STAGING.people;`, freshness, and the daily
reconciliation test.

## 7. Cutover to LF Snowflake (later)
When the LF account is provisioned, change ONLY the Airbyte **destination**
(account + key-pair + database) and re-run STAGING there. Source, slot, publication,
and the module stay put. Drop the trial destination.

## Teardown
Disable the Airbyte connection → confirm the Supabase slot is dropped
(`SELECT pg_drop_replication_slot('snowflake_cdc');` if orphaned, §10.4) → revoke
`snowflake_reader` → remove the Airbyte release → delete the trial account.
