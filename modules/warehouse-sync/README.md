# @gatewaze-modules/warehouse-sync

Replicates a curated, governed subset of a brand's Supabase Postgres into the
Linux Foundation's Snowflake warehouse (`RAW → STAGING` medallion), with
replication-slot safety monitoring, PII masking, delete/erasure propagation, and
reconciliation tests.

Implements **`spec-supabase-to-snowflake-pipeline.md`**. AAIF is the first brand;
the design generalises to any Gatewaze-operated Supabase brand by the same steps.

> **Status: Phase 0/1 scaffold.** The module ships the *source-side* code, the
> reviewable *warehouse-side* artifacts, and the **Airbyte control plane**.
>
> **Chosen mechanism: Option B — one central self-hosted Airbyte OSS on the
> production k8s cluster, serving every brand** (AAIF, techtickets, …) via a
> workspace per brand. This generalises the pipeline to *any* Airbyte-supported
> warehouse, not just Snowflake, and pays the operational cost once across all
> brands. The generator stays swappable (Openflow etc. remain expressible), but
> the defaults target Airbyte's CDC semantics. See `docs/airbyte-deployment.md`.

## What this module owns

| Spec area | Deliverable | Where |
|---|---|---|
| §10 Source prerequisites | Scoped publication + least-privilege roles (opt-in migration) | `migrations/003_source_prerequisites.sql` |
| §10.4 Slot-disk hazard | 5-min slot-health monitor + alerting worker/cron | `workers/slot-monitor.ts`, `migrations/002` |
| §5 Option B | Airbyte control plane: API client, status poller, admin syncs | `lib/airbyte-client.ts`, `workers/airbyte-status.ts`, `api/register-routes.ts` |
| §5 Option B | One central Airbyte, workspace-per-brand, k8s deploy | `docs/airbyte-deployment.md` |
| §12.3 Reconciliation | Daily source-side row-count snapshot worker | `workers/reconcile.ts` |
| §8.1 / Appendix A | Table/column + PII inventory (source of truth) | `manifest/appendix-a.yaml` |
| §8.1 lockstep | Generator: publication, grants, STAGING, masking | `lib/sql-gen.ts`, `scripts/generate-sql.ts` |
| §9 Snowflake objects | Terraform (DB/schemas/warehouse/roles/service acct) | `snowflake/terraform/` |
| §7.2 STAGING contract | Typed, UTC, delete-aware MERGE models | `snowflake/staging/` |
| §7.2.1 / §13 | OPERATIONS tables + tombstone-purge task | `snowflake/operations/operations_ddl.sql` |
| §12.3 Tests | Daily + weekly correctness tests | `snowflake/operations/tests_*.sql` |
| §12.4 Observability | Admin CDC-Health dashboard | `admin/pages/health.tsx` |
| §11 Segment join | Appendix B mapping template | `manifest/appendix-b.example.yaml` |
| §12.2 / §14.6 | Runbooks + decommission | `docs/runbooks.md` |

## The two data planes (§4)

This module is the **relational replica** plane (mutable rows: people, events,
send_log, …). The **behavioral-events** plane (Segment → Snowflake, live since
2026-07-07) is separate and out of scope except for the join key (§11). Analytical
value comes from joining them on the non-PII **person UUID**.

## Install / rollout

1. **Enable the module** → migrations `001`, `002`, `004` apply (operations tables,
   slot-health RPCs, health views). The slot-monitor cron starts.
2. **Phase 0 decisions (§14)** — pin the mechanism, PII posture, target account,
   erasure mechanism, secret store; produce Appendix B; verify Segment `userId`
   is the person UUID. Record in module config + `manifest/appendix-b.yaml`.
3. **Provision Snowflake** via `snowflake/terraform/` (contribute into
   `lfx-snowflake-terraform`; use the `lfx-snowflake-access` skill for exact HCL).
4. **Apply source prerequisites** — `003` is opt-in:
   ```sql
   SET warehouse_sync.apply_source_prereqs = 'on';
   \i migrations/003_source_prerequisites.sql
   ALTER ROLE snowflake_reader WITH PASSWORD '<from secret store>';
   ```
   Confirm `max_slot_wal_keep_size` is bounded (§10.4) and point the connector at
   the **direct** endpoint, never the pooler (§10.3).
5. **Stand up the connector** (chosen mechanism) → RAW. Document RAW semantics
   (§7.1) and set `lib/sql-gen.ts` `RawMeta` to its delete-metadata columns.
6. **Build STAGING** — `pnpm generate:sql`, then apply `snowflake/staging/` +
   `snowflake/operations/`. Wire the daily/weekly tests. Publish to analysts only
   after 7 green days (§14 Phase 3 gate) and **Appendix A merged**.

## Regenerating SQL from the manifest

```bash
pnpm --filter @gatewaze-modules/warehouse-sync generate:sql
```

Reads `manifest/appendix-a.yaml`, validates it (a malformed PII entry fails the
build), and emits `snowflake/staging/generated/*` + refreshes
`lib/reconcile-targets.ts`. **Never hand-edit generated files** — edit the
manifest and regenerate. Adding a table is the deliberate four-step act of §8.1.

## Safety notes

- **Replication slot = production risk (§10.4).** A stalled/orphaned slot retains
  WAL and can fill the Supabase disk. The slot-monitor is the safety net; do not
  disable it while a slot exists. Follow `docs/runbooks.md` to decommission.
- **`003` is opt-in** so a routine `modules:migrate` never creates replication
  roles/publications implicitly.
- **No secrets in git.** Roles are created `PASSWORD NULL`; set from the LF secret
  store (§13).
