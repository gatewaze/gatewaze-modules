# Gatewaze — Snowflake provisioning request (message + questions)

Context: what to send the LF data team / CloudOps to provision the **destination**
for the Gatewaze → Snowflake pipeline. Grounded in a read-only look at the
account (2026-09-01, `XMB01974` / `JNMHVWD-XPB85243`):

- Engineers self-serve only `users.tf` / `service_accounts.tf` in
  `lfx-snowflake-terraform`; **databases, warehouses, and roles are CloudOps-
  owned** (GitHub issue / `#lfx-devops`).
- The datalake is a dbt medallion: an **ingest tier** (`SEGMENT_INGEST`,
  `FIVETRAN_INGEST`, `RAW`, …) → `ANALYTICS` (`SILVER_*`/`GOLD_*`/`PLATINUM_*`).
  New sources land in a `*_INGEST` database and are modelled by dbt.
- So **Gatewaze lands as its own ingest source** — a single
  `GATEWAZE_INGEST` database — beside the existing ingest sources.

> Naming note: `Gatewaze` / `GATEWAZE_INGEST` is the working name for the
> platform in the LF context; swap it if the final product name differs.

---

## Message to post (`#lfx-devops` or a GitHub issue on the datalake repo)

> **Subject: New ingest source — Gatewaze (Postgres → Snowflake via Airbyte)**
>
> Hi CloudOps / data team — we're adding a new **ingest source**: relational CDC
> from the **Gatewaze** platform's Postgres (Supabase) into Snowflake, via a
> self-hosted **Airbyte** already running on our shared k8s cluster (cluster-
> internal, no public ingress). It's a **single platform instance** — one source,
> not multiple.
>
> This complements the Segment behavioural stream; it lands the relational
> system-of-record — community members, foundations, projects, events,
> registrations, content, and sends — curated to an allow-list and PII-governed.
> The model is designed to carry the **LFX foundation/project identifiers** so it
> joins to your existing organization/project dimensions in `ANALYTICS`.
>
> **What we'd like provisioned** (following the `*_INGEST` convention):
> - An **`GATEWAZE_INGEST`** database (Airbyte lands the RAW tables here).
> - A **write role** for the connector — an existing `DB_*_INGEST_RW`-style role
>   scoped to it, or a new `DB_GATEWAZE_INGEST_RW`.
> - A dedicated **loading warehouse** — e.g. `GATEWAZE_LOADING_WH` (XS,
>   auto-suspend 60s) + a `WH_GATEWAZE_LOADING_USAGE` role — so ingest cost
>   is attributable.
> - How you'd like it **modelled downstream**: should your dbt stack model
>   `GATEWAZE_INGEST.*` into `ANALYTICS` (SILVER/GOLD) alongside the other
>   sources, or should we own an `GATEWAZE_ANALYTICS` DB for staging/marts?
>   (We have a medallion transform ready either way.)
> - PII: we can apply Snowflake dynamic data masking in the modelled layer
>   (analysts masked; a narrow break-glass role for plaintext) — confirm that fits
>   your governance or that it's covered by existing datalake policies.
>
> **Service account (we'll submit to `service_accounts.tf` once you confirm the
> role/warehouse names):**
> ```hcl
> "SVC_GATEWAZE_CDC" = {
>   roles             = ["WH_GATEWAZE_LOADING_USAGE", "DB_GATEWAZE_INGEST_RW"],  # confirm names
>   default_warehouse = "GATEWAZE_LOADING_WH",                                        # CloudOps to create
>   default_role      = "SVC_GATEWAZE_CDC",
>   ip_list           = local.ip_list_k8s_clusters,   # Airbyte runs on the shared k8s cluster
> },
> ```
> Airbyte's Snowflake destination uses **key-pair auth** — we'll generate the RSA
> keypair and send you the public key to register.
>
> **Questions:**
> 1. OK to create `GATEWAZE_INGEST` as a new ingest source?
> 2. Preferred **role + warehouse names** for the connector service account.
> 3. Downstream modelling: your dbt into `ANALYTICS`, or an
>    `GATEWAZE_ANALYTICS` DB we own?
> 4. **Key-pair** auth OK, and where do we send the public key?
> 5. Are the **shared k8s egress IPs** (`local.ip_list_k8s_clusters`) the right SA
>    allowlist?
> 6. Do you have canonical **foundation/project identifiers** (SFID / project_id)
>    we should key on so the community data joins your org/project dimensions?
>
> **Heads-up (separate issue):** the `SEGMENT_INGEST.AAIF_APP_SERVER_PROD` /
> `_DEV` schemas are **empty** — that Segment source is registered but has landed
> no events in Snowflake. Whoever owns that Segment destination may want to check
> the sync; it's needed for the relational↔event join to have anything to join to.

---

## What we need back
| From | What |
|---|---|
| CloudOps | Approve `GATEWAZE_INGEST` + `GATEWAZE_LOADING_WH` + a write role; confirm role/warehouse names; register the `SVC_GATEWAZE_CDC` key-pair; confirm downstream modelling; share canonical foundation/project IDs to key on |
| Segment owner | Why the Segment source schema is empty — get its Snowflake sync flowing |
| Our side | Airbyte is deployed; needs the destination creds + the source/connection config once the above lands |

## Confirmed facts
- Account `XMB01974` (`JNMHVWD-XPB85243`) — same account Segment feeds, so intra-account joinable.
- Landing = a single `GATEWAZE_INGEST` database, dbt-modelled — following the `*_INGEST` convention.
- `dbaker@linuxfoundation.org` is read-only here (no DB/warehouse creation), so this is a CloudOps provision.
