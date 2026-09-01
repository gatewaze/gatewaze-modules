# Warehouse Sync

Replicates a curated, governed subset of the Gatewaze Supabase Postgres into a data
warehouse so member, event, sending, and content data can be analysed there and joined
to the Segment behavioral-event stream. The mechanism is **Airbyte**: a self-hosted
Airbyte on the production Kubernetes cluster, so any Airbyte-supported destination
works. **Snowflake is the first destination**, and the warehouse-side artifacts this
module carries target it.

No third-party data processor sits in the path — data flows from the Gatewaze Supabase
directly to the operator's own warehouse, which keeps the cross-org data-sharing story
to two parties.

## The two data planes

This module is **one half** of the analytics picture. Keep the two straight:

| Plane | Source | Shape | Owned by |
|---|---|---|---|
| **Relational replica** (this module) | Supabase `public` tables | Mutable rows: people, events, send_log, … | Warehouse Sync |
| **Behavioral events** | `@gatewaze/tracking` → Segment | Append-only event stream | the Segment "Marketing Ops" workspace |

Events tell you *what someone did in the browser*; the relational replica tells you
*the current state of the system of record*. The analytical value comes from **joining
them on the non-PII person UUID** (never email — one person owns many emails).

## How it works

### 1. Airbyte in the cluster

```
                         ┌──────────── Kubernetes cluster ────────────┐
  Gatewaze Supabase ─────▶│  Airbyte (private, ClusterIP, no ingress)  │──▶ Snowflake
  (direct endpoint, CDC) │    external Postgres + private S3           │   (GATEWAZE_INGEST)
                         └──────────▲──────────────────────────────────┘
                                    │ public API (in-cluster)
                      Warehouse Sync admin proxy (token stays server-side)
```

The Airbyte platform is deployed on the cluster (full Helm chart), cluster-internal
(no public ingress). It holds the Postgres source (the Gatewaze Supabase direct
endpoint + the `snowflake_reader` role), the destination (`GATEWAZE_INGEST`), and the
connection (the streams = the publication tables). The module drives it through its
admin proxy, which holds the Airbyte token server-side. See `docs/airbyte-deployment.md`.

### 2. The medallion in the warehouse

```
Supabase public.*  ──Airbyte CDC──▶  RAW      1:1 replica, Airbyte-owned, never hand-edited
                                       │ scheduled MERGE transforms
                                       ▼
                                     STAGING  typed · UTC · PII-masked · delete-aware  ← the contract
                                       │
                                       ▼
                                     MARTS    conformed models (downstream, out of scope)
                                     OPERATIONS  tests, reconciliation, tombstone purge
```

- **RAW** is Airbyte's output (typed final tables with `_ab_cdc_deleted_at` /
  `_ab_cdc_updated_at`). Analysts never read it.
- **STAGING** is the only stable contract: one current-state table per source table,
  with a deterministic PK, all timestamps stored UTC (`TIMESTAMP_NTZ`), `_synced_at`,
  and `is_deleted` / `deleted_at`. Built by idempotent `MERGE` (large facts like
  `send_log` incrementally), so a failed run leaves the prior table intact — stale but
  never partially published.

### 3. Governance is generated from one manifest

`manifest/appendix-a.yaml` is the single source of truth: every in-scope table, every
column, its PII classification, and its masking policy. A table not listed is out of
scope by construction. The generator (`pnpm generate:sql`) derives, in lockstep, the
four things that must never drift apart:

1. the source **publication** (what Postgres streams),
2. the **SELECT grants** to the extraction role,
3. the **STAGING** transforms,
4. the warehouse **masking policies**.

Adding a table is the deliberate act of editing the manifest and regenerating — you
cannot accidentally leak a table or an unmasked column.

### 4. PII, deletes, and erasure

- **Masking (PII-1 default):** email is reduced to its domain, names are nulled for the
  analyst role, IP/user-agent are fully masked. Only a time-bound break-glass role sees
  plaintext. A deterministic `email_sha256 = SHA2(LOWER(TRIM(email)))` join key is
  exposed where cross-dataset joins are needed.
- **Deletes:** soft deletes carry `deleted_at` through; hard deletes leave a tombstone
  row on the original key with direct identifiers **and their derived hashes nulled** —
  so an erased person is neither readable nor joinable. This doubles as GDPR erasure,
  which propagates to STAGING within 24h. Tombstones are purged after 90 days by a
  scheduled task.

### 5. The replication-slot safety net

Airbyte's CDC uses a Postgres logical replication slot (Debezium). **A stalled or
orphaned slot retains write-ahead log and can fill the Supabase disk** — the single
biggest operational risk. The `warehouse-sync:slot-monitor` worker samples the slot
every 5 minutes (retained WAL, replication lag, active/inactive) and raises alerts on
threshold breaches, optionally to a webhook. **Keep it enabled while a slot exists**,
and always follow the decommission runbook (`docs/runbooks.md`) when tearing the sync
down — skipping the slot-drop re-triggers the disk hazard.

### 6. Correctness checks

- `warehouse-sync:reconcile` (daily) snapshots source-side row counts; the warehouse
  daily test diffs STAGING against them (exact for dimensions, tolerance for large
  facts), plus freshness and masking assertions.
- A weekly test seeds and deletes a marked test subject to prove erasure lands within
  SLA, and samples Segment events to confirm `userId` resolves to a STAGING person.

### 7. Admin surface

A **Warehouse Sync** nav item opens the CDC-Health dashboard: replication-slot state
(retained WAL, lag, active), open alerts, the Airbyte connections and their last sync
(with a "Sync now" button that runs server-side so the Airbyte token never reaches the
browser), and the latest reconciliation snapshot.

## Setup

1. **Enable the module** — migrations create the operations tables, the slot-health
   RPCs, the health views, and the Airbyte-status table; the slot-monitor cron starts.
2. **Provision the warehouse** — apply `snowflake/terraform/` (database, `RAW`/`STAGING`
   /`MARTS`/`OPERATIONS` schemas, a loading warehouse, the least-privilege roles, and
   the CDC service account).
3. **Apply source prerequisites** — migration `003` is opt-in (it creates replication
   roles + the publication, which must never run implicitly):
   ```sql
   SET warehouse_sync.apply_source_prereqs = 'on';
   \i migrations/003_source_prerequisites.sql
   ALTER ROLE snowflake_reader WITH PASSWORD '<from the secret store>';
   ```
   Confirm `max_slot_wal_keep_size` is bounded, and use the Supabase **direct** endpoint,
   never the pooler.
4. **Wire Airbyte** — in the Airbyte workspace, create the Postgres (CDC) source, the
   warehouse destination, and the connection (streams = the in-scope tables). Then set
   the config below.
5. **Build STAGING** — `pnpm generate:sql`, apply `snowflake/staging/` +
   `snowflake/operations/`, wire the tests. Publish to analysts only after the manifest
   is merged and the checks pass for 7 consecutive days.

## Configuration

| Key | Required | Default | Description |
|---|---|---|---|
| `mechanism` | No | `airbyte` | Replication mechanism. Airbyte is the default; other connectors stay expressible. |
| `piiPosture` | No | `pii-1` | `pii-1` masks in STAGING; `pii-2` keeps no plaintext PII in the warehouse at all. |
| `snowflakeDatabase` | No | `GATEWAZE_INGEST` | Ingest landing database for this instance. |
| `replicationSlotName` | No | `snowflake_cdc` | The slot the connector owns; the slot-monitor watches this name. |
| `airbyteApiUrl` | No | — | Cluster-internal Airbyte server URL (must be private — no public ingress). |
| `airbyteWorkspaceId` | No | — | The Airbyte workspace UUID; scopes every API call. |
| `airbyteApiToken` | No | — | Bearer token for the Airbyte API (from the secret store). |
| `retainedWalAlertGb` | No | `10` | Alert when a slot retains more WAL than this. |
| `lagAlertMinutes` | No | `30` | Alert when replication lag exceeds this. |
| `slotInactiveAlertMinutes` | No | `15` | Alert when the slot is inactive longer than this (business hours). |
| `alertWebhookUrl` | No | — | Optional Slack/PagerDuty webhook for slot + failed-sync alerts. |

## Safety notes

- **Never expose the Airbyte UI/API publicly** — keep it ClusterIP-only and reach it
  through this module's admin proxy.
- **Migration `003` is opt-in** so a routine `modules:migrate` never creates replication
  roles or a publication by accident.
- **No secrets in git** — roles are created `PASSWORD NULL`; the Airbyte/Snowflake
  credentials come from the secret store.
- **The slot is the risk** — keep the monitor on, and follow the decommission runbook.
