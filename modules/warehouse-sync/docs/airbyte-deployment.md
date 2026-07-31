# Airbyte deployment (Option B) — one central Airbyte, many brands

This is the chosen mechanism (§5, Option B): **one** self-hosted Airbyte on the
production Kubernetes cluster, serving **every** Gatewaze brand (AAIF,
techtickets, …). The operational cost is paid once and amortised across brands;
each brand is one Airbyte **workspace** with its own source, destination, and
connection.

```
                         ┌──────────────────────────── Kubernetes cluster ───────────────────────────┐
  AAIF Supabase ─(CDC)──▶│  Airbyte (namespace: airbyte, ClusterIP only, NO public ingress)           │──▶ AAIF Snowflake
  (direct endpoint)      │    server · worker · temporal · webapp · cron · connector-builder          │
                         │    external metadata Postgres  +  private S3 (logs/state)                  │
  techtickets Supabase ─▶│    workspace: AAIF          workspace: techtickets                         │──▶ techtickets warehouse
                         └────────────▲──────────────────────────────────────────────────────────────┘
                                      │ public API (in-cluster)
                    each brand's Gatewaze admin proxy (LFID/admin-gated) ── scoped to its workspaceId
```

## 1. Install (full Helm chart)

Use the official `airbyte/airbyte` Helm chart. **Externalise state** (do not run
the bundled Postgres/minio in production):

```yaml
# values-airbyte.yaml (essentials)
global:
  edition: community
  database:
    # external managed Postgres (RDS / managed) — NOT the in-chart one
    host: <airbyte-metadata-pg-host>
    port: 5432
    database: airbyte
    secretName: airbyte-db
  storage:
    type: S3            # logs + state in a PRIVATE, encrypted bucket
    bucket:
      log: airbyte-logs-<env>
      state: airbyte-state-<env>
    s3:
      region: us-west-1
      authenticationType: instanceProfile   # or a scoped IAM key from secret store

webapp:
  ingress:
    enabled: false      # HARD RULE (§13): never expose the UI publicly

server:
  # ClusterIP; reached only in-cluster by the Gatewaze admin proxy
  service:
    type: ClusterIP

worker:
  # size for the SUM of concurrent syncs across all brands (multi-pod)
  replicaCount: 2
  resources:
    requests: { cpu: "1", memory: 2Gi }
    limits:   { cpu: "2", memory: 4Gi }
```

```bash
helm repo add airbyte https://airbytehq.github.io/helm-charts
helm upgrade --install airbyte airbyte/airbyte \
  --namespace airbyte --create-namespace \
  --values values-airbyte.yaml
```

RBAC: Airbyte spawns ephemeral connector pods — scope its ServiceAccount to the
`airbyte` namespace only, **never cluster-admin**.

## 2. Per-brand wiring (repeat per brand)

Create, in the brand's **own workspace**:

1. **Source — Postgres (CDC):**
   - Host: the brand's Supabase **direct** endpoint (`db.<ref>.supabase.co:5432`),
     **not** the pooler (§10.3). IPv4 add-on if the cluster egress is IPv4-only.
   - User/password: the `snowflake_reader` role (§10.2). `sslmode=verify-full` (§13).
   - Replication method: **CDC (logical replication)**; publication `snowflake_cdc`;
     replication slot `snowflake_cdc` (matches the module's `replicationSlotName`
     config so the slot-monitor watches the right slot).
   - Streams: the in-scope tables from Appendix A (nothing more).
2. **Destination — Snowflake:**
   - Database `AAIF` (or the brand's), schema `RAW`, warehouse `AAIF_LOADING_WH`.
   - Auth: key-pair as `SVC_AAIF_CDC` (§9.1). Typing & Deduping ON → typed final
     tables in `RAW` with `_ab_cdc_deleted_at` / `_ab_cdc_updated_at` (matches
     `AIRBYTE_RAW_META` in `lib/sql-gen.ts`).
3. **Connection:** source → destination, incremental + dedupe, schedule to meet
   the freshness SLA (§12.4; ~5–15 min). Normalisation lands the typed tables the
   STAGING models read.

Then set the module config for that brand:

```
mechanism         = airbyte
airbyteApiUrl     = http://airbyte-airbyte-server-svc.airbyte:8001   (in-cluster, private)
airbyteWorkspaceId= <this brand's workspace UUID>
airbyteApiToken   = <from secret store, if the instance is authenticated>
replicationSlotName = snowflake_cdc
```

The `warehouse-sync:airbyte-status` worker then polls that workspace and the
dashboard shows the connection health; the slot-monitor independently watches the
Debezium replication slot Airbyte created (the §10.4 hazard applies to Airbyte's
slot exactly as to any connector's).

## 3. Security model (§13)

- **No public ingress on Airbyte.** UI/API are ClusterIP-only. Operators reach the
  UI via `kubectl port-forward`/VPN; the app reaches the API only through the
  per-brand admin proxy (`/api/modules/warehouse-sync/airbyte/*`), which is
  LFID/admin-gated and holds the Airbyte token server-side.
- **Credentials** (Supabase reader, Snowflake key-pair, Airbyte token) come from
  the LF secret store via k8s Secrets / external-secrets — never in values or git.
- **TLS end to end:** source `sslmode=verify-full`; destination over TLS.
- **Private, encrypted S3** for logs/state; keep Airbyte log level at info (debug
  logs can contain record-level PII).
- **Workspace isolation is soft in OSS** — anyone with instance API access can
  reach all workspaces (hard RBAC is Enterprise). Acceptable because all brands
  are one operator (the LF); the real isolation is the per-brand admin proxy +
  network isolation. Note this in the DPA/governance record.
- **Trust boundary:** all PII stays inside LF-operated infra — no third-party
  processor added (the clean two-party DPA holds), but PII does transit Airbyte
  connector pods + the state store; record that footprint.

## 4. Decommission a brand

Disable that brand's Airbyte **connection**, then follow `runbooks.md` §14.6:
confirm the Debezium **replication slot is dropped** on that brand's Supabase
(else the §10.4 WAL-disk hazard re-triggers), revoke the Supabase `snowflake_reader`
role, and revoke the Snowflake service account. The central Airbyte keeps serving
the other brands.
