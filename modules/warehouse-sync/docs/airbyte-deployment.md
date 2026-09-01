# Airbyte deployment (Option B)

The chosen mechanism (§5, Option B): a self-hosted Airbyte on the production
Kubernetes cluster, cluster-internal, running the CDC from the Gatewaze Supabase
into Snowflake. Single instance — one Postgres source, one Snowflake destination,
one connection.

```
                         ┌──────────────── Kubernetes cluster ────────────────┐
  Gatewaze Supabase ─────▶│  Airbyte (ClusterIP only, NO public ingress)       │──▶ Snowflake
  (direct endpoint, CDC) │    server · worker · temporal · cron · db · minio  │   (GATEWAZE_INGEST)
                         └────────────▲────────────────────────────────────────┘
                                      │ public API (in-cluster)
                    Gatewaze Warehouse Sync admin proxy ── holds the token server-side
```

> **Deployed state (this cluster):** added as a helmfile release (`airbyte`,
> chart `airbyte/airbyte` 1.8.5) in the `gatewaze` namespace — see
> `gatewaze-environments/k8s/values-airbyte.yaml` + `helmfile.yaml.gotmpl`.
> Deploy just this release: `helmfile -l name=airbyte apply`.

## 1. Install (Helm)

Use the official `airbyte/airbyte` chart (pinned 1.8.5). For a durable production
install, **externalise state** — do not run the bundled Postgres/minio:

```yaml
# values-airbyte.yaml (essentials)
global:
  edition: community
  database:                     # external managed Postgres (NOT the in-chart one)
    host: <airbyte-metadata-pg-host>
    port: 5432
    database: airbyte
    secretName: airbyte-db
  storage:
    type: S3                    # logs + state in a PRIVATE, encrypted bucket
    bucket: { log: airbyte-logs, state: airbyte-state }
    s3: { region: us-east-1, authenticationType: instanceProfile }

webapp:
  ingress: { enabled: false }   # HARD RULE (§13): never expose the UI publicly
  service: { type: ClusterIP }
server:
  service: { type: ClusterIP }  # reached only in-cluster by the admin proxy

# Chart defaults some services (e.g. connector-builder-server) to NodePort —
# LKE nodes have public IPs, so force ClusterIP:
connector-builder-server:
  service: { type: ClusterIP }
```

RBAC: Airbyte spawns ephemeral connector pods — scope its ServiceAccount to its
namespace only, **never cluster-admin**.

## 2. Wire the sync

1. **Source — Postgres (CDC):**
   - Host: the Gatewaze Supabase **direct** endpoint (`db.<ref>.supabase.co:5432`),
     **not** the pooler (§10.3). IPv4 add-on if the cluster egress is IPv4-only.
   - User/password: the `snowflake_reader` role (§10.2). `sslmode=verify-full` (§13).
   - Replication method: **CDC (logical replication)**; publication `snowflake_cdc`;
     replication slot `snowflake_cdc` (matches the module's `replicationSlotName`
     config so the slot-monitor watches the right slot).
   - Streams: the in-scope tables from Appendix A (nothing more).
2. **Destination — Snowflake:**
   - Database `GATEWAZE_INGEST`, schema `RAW`, warehouse `GATEWAZE_LOADING_WH`.
   - Auth: key-pair as `SVC_GATEWAZE_CDC` (§9.1). Typing & Deduping ON → typed
     final tables in `RAW` with `_ab_cdc_deleted_at` / `_ab_cdc_updated_at`
     (matches `AIRBYTE_RAW_META` in `lib/sql-gen.ts`).
3. **Connection:** source → destination, incremental + dedupe, schedule to meet
   the freshness SLA (§12.4; ~5–15 min).

Then set the module config:

```
mechanism           = airbyte
airbyteApiUrl       = http://airbyte-airbyte-server-svc.gatewaze:8001   (in-cluster, private)
airbyteWorkspaceId  = <workspace UUID>
airbyteApiToken     = <from the secret store, if the instance is authenticated>
replicationSlotName = snowflake_cdc
```

The `warehouse-sync:airbyte-status` worker then polls the workspace and the
dashboard shows connection health; the slot-monitor independently watches the
Debezium replication slot Airbyte created (the §10.4 hazard applies to Airbyte's
slot exactly as to any connector's).

## 3. Security model (§13)

- **No public ingress, no NodePort/LoadBalancer.** UI/API are ClusterIP-only.
  Operators reach the UI via `kubectl port-forward`; the app reaches the API only
  through the admin proxy (`/api/modules/warehouse-sync/airbyte/*`), which is
  admin-gated and holds the Airbyte token server-side.
- **Credentials** (Supabase reader, Snowflake key-pair, Airbyte token) come from
  the secret store via k8s Secrets / external-secrets — never in values or git.
- **TLS end to end:** source `sslmode=verify-full`; destination over TLS.
- **Private, encrypted S3** for logs/state; keep Airbyte log level at info (debug
  logs can contain record-level PII).
- **Trust boundary:** all PII stays inside operator infra — no third-party
  processor added (the clean two-party DPA holds), but PII does transit Airbyte
  connector pods + the state store; record that footprint.

## 4. Decommission

Disable the Airbyte **connection**, then follow `runbooks.md` §14.6: confirm the
Debezium **replication slot is dropped** on Supabase (else the §10.4 WAL-disk
hazard re-triggers), revoke the Supabase `snowflake_reader` role, and revoke the
Snowflake service account.
