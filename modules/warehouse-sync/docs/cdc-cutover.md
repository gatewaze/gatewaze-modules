# CDC cutover runbook (AAIF prod)

Turn the AAIF Supabase → Snowflake pipeline from cursor-based incremental into
**true log-based CDC** (§10). Written against the verified prod state below.

## Verified prod state (2026-09-01)

Checked directly against the AAIF Supabase (`ktkkanmhbygivyzzyfex`) and the LKE
cluster (`lke550723`, namespace `gatewaze`):

| Control | Value | Meaning |
|---|---|---|
| `wal_level` | `logical` | Logical replication already enabled — CDC-ready. |
| `max_slot_wal_keep_size` | `4096MB` | §10.4 control #3 **already set**: a runaway slot is dropped at 4 GB, not allowed to fill the disk. |
| `max_replication_slots` | `10` | Headroom. |
| `max_wal_senders` | `10` | Headroom. |
| existing slots | none | Clean — nothing retaining WAL today. |

## The blocker (why CDC isn't live yet)

The connector needs a logical replication **slot**, which the Supabase
**pooler cannot host**. Slots live only on the **direct** endpoint
`db.ktkkanmhbygivyzzyfex.supabase.co:5432`. That hostname currently resolves to
**IPv6 only** (`2600:1f1c:…`), and the LKE cluster is **IPv4-only** — a pod gets
`ENETUNREACH`. So the direct endpoint is unreachable from where Airbyte runs.

**Chosen fix:** enable the Supabase **dedicated-IPv4 add-on** on the AAIF project
so the direct endpoint gets an A record the cluster can reach.

### Enable the IPv4 add-on (operator, billing action)

Supabase dashboard → project `ktkkanmhbygivyzzyfex` → **Project Settings →
Add-ons → Dedicated IPv4 address** → enable. (~$4/mo.) Wait for the A record:

```
dig +short A db.ktkkanmhbygivyzzyfex.supabase.co   # should now return an IPv4
```

## Cutover sequence (run once IPv4 is live)

Order matters — the slot-monitor guard must be watching *before* a slot exists.

1. **Confirm reachability from the cluster** (was `ENETUNREACH`):
   ```bash
   kubectl -n gatewaze exec deploy/aaif-api -- node -e \
     'const s=require("net").connect({host:"db.ktkkanmhbygivyzzyfex.supabase.co",port:5432,timeout:8000});
      s.on("connect",()=>{console.log("OK");s.end()});s.on("error",e=>console.log(e.code))'
   ```

2. **Confirm the slot-monitor cron is live** (`warehouse-sync-slot-monitor`,
   every 5 min). It samples `pg_replication_slots` via the SECURITY DEFINER RPC
   and alerts on the §10.4 thresholds. This is the guard — it must be running
   first.

3. **Apply source prerequisites (migration 003)** — creates the `snowflake_cdc`
   publication (explicit table list) + the least-privilege roles. **No slot is
   created here; zero WAL retention starts.** Run against the direct endpoint (or
   pooler — plain SQL is fine) with the opt-in GUC:
   ```sql
   SET warehouse_sync.apply_source_prereqs = 'on';
   \i migrations/003_source_prerequisites.sql
   ```

4. **Set the reader password** (role is created `PASSWORD NULL` = cannot log in):
   ```sql
   ALTER ROLE snowflake_reader WITH PASSWORD '<generated; store in LF secret store>';
   ```

5. **Reconfigure the Airbyte source** → Postgres **CDC (logical replication)**:
   - Host `db.ktkkanmhbygivyzzyfex.supabase.co`, port `5432` (**direct, not the
     pooler**), user `snowflake_reader`.
   - Replication slot `snowflake_cdc`, publication `snowflake_cdc`.

6. **Enable the CDC tables in the admin → Sync Tables tab** (mode *incremental*,
   `use_cdc` on, realtime tier) and **Save & apply**. The reconcile creates/updates
   the realtime Airbyte connection; its first sync is when the **slot is created**
   and WAL retention begins — with the monitor already watching and the 4 GB cap
   as backstop.

7. **Watch the first sync**: dashboard → retained-WAL / lag stay under threshold;
   `pg_replication_slots.active = true`.

## Fallback (no add-on)

Cursor-based incremental over the **pooler** (`updated_at` cursor + `id` PK,
`incremental_deduped_history`) on the realtime (5-min) tier needs **no slot** and
carries **no WAL-disk risk**. Configure it entirely from the Sync Tables tab —
this is the safe default until the IPv4 add-on is enabled.

## Separate dependency: the real Snowflake destination

The pipeline has been proven end-to-end into a **trial** Snowflake account. Landing
**production** data needs the real `GATEWAZE_INGEST` database + warehouse + role +
connector service account, provisioned by **LF CloudOps** via the
`lfx-snowflake-terraform` repo (service account in `service_accounts.tf`; the
database/warehouse/roles are a CloudOps change). See `docs/lf-provisioning-request.md`.
