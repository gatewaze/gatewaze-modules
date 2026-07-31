# Runbooks — Supabase → Snowflake pipeline

Recovery playbooks (§12.2) and decommission (§14.6). These MUST exist before
production. Alert thresholds and their meaning are in `lib/thresholds.ts`; the
slot-monitor writes alerts to `public.warehouse_sync_alerts`.

## The one that can take down production: the replication slot (§10.4)

A logical replication slot retains WAL until the consumer (connector)
acknowledges it. A stalled or orphaned slot accumulates WAL and can **fill the
Supabase disk**, degrading or halting production.

Signals (from the CDC-Health dashboard / `warehouse_sync_open_alerts`):

| Alert code | Meaning | First action |
|---|---|---|
| `retained_wal` | Slot retaining > 10 GB WAL | Check connector is running and consuming; if dead, see "orphaned slot" below |
| `replication_lag` | Consumer > 30 min behind | Check connector health + Snowflake load errors |
| `slot_inactive` | No walsender attached > 15 min | Connector is down — restart it |
| `slot_missing` | Slot not present at all | Connector not provisioned, or slot was dropped |

### Connector down < 30 min
1. Restart the connector runtime.
2. Confirm the slot is `active` again (dashboard, or `warehouse_sync_slot_health`).
3. Confirm lag is recovering (retained WAL trending down).

### Orphaned slot / slot exceeded keep size → re-snapshot
1. Decide whether a re-snapshot is acceptable (off-peak; `send_log` dominates, §10.5).
2. If abandoning the slot, drop it explicitly so WAL sheds:
   ```sql
   SELECT pg_drop_replication_slot('snowflake_cdc');
   ```
3. Recreate the slot via the connector, run the initial snapshot off-peak,
   validate counts (reconciliation test) before re-enabling analyst access.

### DB guardrail (preventive, §10.4 control #3)
Confirm `max_slot_wal_keep_size` is bounded for the Supabase plan
(`SELECT * FROM warehouse_sync_slot_guardrail();`). A dead slot then sheds
WAL rather than filling disk — at the cost of forcing a re-snapshot if it falls
too far behind.

## Bad schema drift (§7.3, §12.2)
- **Additive column:** no action — RAW gains it, STAGING ignores it (explicit
  column SELECTs).
- **Dropped/renamed column (breaking):** freeze STAGING refresh, pin the RAW
  version, apply the coordinated source change + STAGING migration
  (`manifest/appendix-a.yaml` + `pnpm generate:sql`), then unfreeze.

## Secret rotation (§12.2)
Rotate the Postgres/Snowflake credential and update **both** the LF secret store
and the `aaif.production.env` mirror **without dropping the slot**:
```sql
ALTER ROLE snowflake_reader WITH PASSWORD '<new-from-secret-store>';
```
Then update the connector config with the new credential and restart it. The slot
survives a credential change.

## Snowflake permission / quota failure (§12.1)
Alert, pause the connector, fix via Terraform (no ad-hoc grants outside
`lfx-snowflake-terraform` except emergency break-glass with post-incident
reconciliation).

## Decommission (§14.6) — do NOT skip step 2
1. **Disable the connector** (stop consuming).
2. **Confirm the replication slot is dropped** — otherwise the §10.4 WAL-disk
   hazard re-triggers:
   ```sql
   SELECT slot_name, active FROM pg_replication_slots WHERE slot_name = 'snowflake_cdc';
   SELECT pg_drop_replication_slot('snowflake_cdc');  -- if still present
   ```
3. **Revoke the Supabase role**: `DROP ROLE snowflake_reader;` (and monitor/verifier).
4. **Revoke the Snowflake service account** via Terraform.
5. Disable this module (stops the slot-monitor cron). The `slot_missing` alert is
   expected after decommission — resolve/silence it.

## Rollback (§14.6)
- **Connector:** roll back to the previous image + config **without** touching
  the slot or publication.
- **Transforms:** roll back the dbt/SQL project version; STAGING tables stay
  last-known-good (each MERGE is atomic per target).
