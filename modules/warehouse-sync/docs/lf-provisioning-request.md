# LF Snowflake provisioning — message + questions to get this actionable

Context for the reader: this is what to send the LF data team / CloudOps to get
the **destination** side of the Gatewaze → Snowflake pipeline provisioned. At the
LF, engineers self-serve only `users.tf` / `service_accounts.tf` in
`lfx-snowflake-terraform`; **databases, schemas, warehouses, and roles are
CloudOps-owned** (GitHub issue / `#lfx-devops`). So this splits into (1) a CloudOps
ask for the objects, (2) a service-account request we can submit, and (3) the
decisions we need back.

---

## Message to post (`#lfx-devops` or a GitHub issue on the datalake repo)

> **Subject: Landing the AAIF (Gatewaze) Supabase database into Snowflake — destination provisioning + an architecture check**
>
> Hi CloudOps / data team — we're standing up CDC replication from the AAIF
> production **Supabase Postgres** into Snowflake (via a self-hosted **Airbyte**
> on our shared k8s cluster). The behavioural-event stream already lands from
> Segment ("Marketing Ops" workspace); this adds the **relational** system-of-record
> tables (people, events, registrations, sends, engagement), curated to an
> allow-list and PII-governed. DPA/engagement on the LF side is in place.
>
> **The one decision that gates everything — where should AAIF land?**
> 1. **Into your existing datalake conventions** — an AAIF *schema* in your RAW
>    database, using your ingest/RAW roles and modelled by your dbt stack. We hand
>    you a clean RAW feed and you own transforms; or
> 2. **A standalone `AAIF` database** with its own medallion (`RAW`→`STAGING`→
>    `MARTS`→`OPERATIONS`) that we own and model, sitting in the same account.
>
> We've built for (2) (reference Terraform below) but we'd rather fit your
> conventions if you prefer (1). Your call — it decides the roles, the warehouse,
> and who owns the transforms.
>
> **What we'd need CloudOps to provision** (whichever model):
> - A landing **database/schema** for AAIF RAW (+ STAGING/OPERATIONS if model 2).
> - A dedicated **loading warehouse** (XS, auto-suspend 60s) so ingest cost is
>   attributable — e.g. `WH_AAIF_LOADING` + a `WH_AAIF_LOADING_USAGE` role.
> - A **write role** for the connector to land RAW (an existing `DB_RAW_RW`-style
>   role scoped to the AAIF schema, or a new `DB_AAIF_RAW_RW`).
> - If we apply PII masking in-warehouse (dynamic data masking, analysts see
>   masked; a narrow break-glass role sees plaintext) — confirm that fits your
>   governance, or tell us it's handled by your existing datalake policies.
>
> **Service account (we'll submit to `service_accounts.tf` once you confirm the
> role/warehouse names):**
> ```hcl
> "SVC_AAIF_CDC" = {
>   roles             = ["WH_AAIF_LOADING_USAGE", "DB_AAIF_RAW_RW"],  # confirm names
>   default_warehouse = "AAIF_LOADING_WH",                            # CloudOps to create
>   default_role      = "SVC_AAIF_CDC",
>   ip_list           = local.ip_list_k8s_clusters,   # Airbyte runs on the shared k8s cluster
> },
> ```
> Airbyte's Snowflake destination uses **key-pair auth** — happy to generate the
> RSA keypair and send you the public key to register on the account.
>
> **Questions:**
> 1. Model (1) or (2) above?
> 2. Which **Snowflake account** — the same one the Segment "Marketing Ops"
>    destination feeds? (We want the relational replica joinable to the events in
>    the same account.)
> 3. The exact **role + warehouse names** you want the connector SA to hold.
> 4. **Key-pair** auth OK, and where do we send the public key?
> 5. Are the **shared k8s cluster egress IPs** (`local.ip_list_k8s_clusters`) the
>    right allowlist for the SA, or do you need specific IPs?
> 6. Any network/PrivateLink requirement on the Snowflake ingress side?
>
> Reference: the object set we designed (adapt as you see fit) is the Terraform in
> our `warehouse-sync` module (`snowflake/terraform/main.tf`) — database `AAIF`,
> schemas `RAW/STAGING/MARTS/OPERATIONS`, warehouse `AAIF_LOADING_WH`, roles
> `AAIF_CDC_ROLE / AAIF_STAGING_ROLE / AAIF_ANALYST_ROLE / AAIF_PII_BREAKGLASS_ROLE`,
> service account `SVC_AAIF_CDC`. Happy to hop on a call.

---

## What I (Dan) need back to make this actionable

| From | What | Why |
|---|---|---|
| LF data team / CloudOps | Model (1 vs 2) + account + role/warehouse/db names + key-pair confirmation + IP allowlist | Unblocks the service-account PR and the Airbyte Snowflake destination config |
| Whoever has Segment access (we do) | The Segment → Snowflake **database / schema / table names** and confirm `supabase_user_id` landed as a column | Fills `manifest/appendix-b.yaml` so the relational↔event join works |
| Our side (k8s) | Deploy Airbyte on the cluster (full Helm, external Postgres + private S3) and the Airbyte egress IPs | The connector runtime itself; separate from the LF Snowflake ask |
| DPO (if not already) | Confirm PII-1 posture + `BYPASSRLS` on the Supabase reader role are accepted | Source-side prerequisite (§8.4) |

## Still-ours-to-do (code, in progress)

- Reconcile the allow-list manifest to the real AAIF schema (the committed one is
  speculative — wrong table names, profile fields in `attributes` jsonb, hard
  delete) and add jsonb-extract to the generator. Tracked as G1–G3 in
  `gap-analysis.md`. This is independent of the LF provisioning and I can do it now.
