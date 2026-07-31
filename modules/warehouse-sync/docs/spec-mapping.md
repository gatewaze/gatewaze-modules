# Spec → file mapping

Traceability from `spec-supabase-to-snowflake-pipeline.md` to this module.

| Spec § | Topic | Implemented in |
|---|---|---|
| §4 | Two data planes | This module = relational plane; Segment = events plane (join only, §11) |
| §5 / §5.1 | Mechanism options + recommendation | **Chosen: Option B / Airbyte OSS.** `lib/airbyte-client.ts`, `workers/airbyte-status.ts`, `api/register-routes.ts`, `docs/airbyte-deployment.md`; still swappable via `configSchema.mechanism` |
| §6 | Medallion architecture | `snowflake/terraform/main.tf` (schemas), `snowflake/staging/`, `snowflake/operations/` |
| §7.1 | RAW semantics (connector-owned) | `lib/sql-gen.ts` `RawMeta`; `snowflake/staging/_conventions.sql` |
| §7.2 | STAGING contract | `lib/sql-gen.ts`, `snowflake/staging/people.sql`, `send_log.sql` |
| §7.2.1 | Delete semantics + tombstones | `lib/sql-gen.ts` (identifier nulling), `snowflake/operations/operations_ddl.sql` (purge) |
| §7.3 | Schema-drift policy | Explicit-column SELECTs; `docs/runbooks.md` |
| §8.1 | Table scope (allow-list) | `manifest/appendix-a.yaml` + generator lockstep |
| §8.2 | PII posture + masking + join key | `manifest/appendix-a.yaml`, `snowflake/staging/masking_policies.sql`, `configSchema.piiPosture` |
| §8.3 | GDPR erasure propagation | Tombstone nulling (STAGING), `tests_weekly.sql` delete-propagation |
| §8.4 | RLS interaction (BYPASSRLS) | `migrations/003_source_prerequisites.sql` |
| §9 | Snowflake provisioning | `snowflake/terraform/` |
| §10.1 | Publication | `migrations/003`, generated `publication.sql` |
| §10.2 | Scoped roles | `migrations/003` |
| §10.3 | Pooler caveat / direct endpoint | `README.md`, `docs/runbooks.md` (Phase-0 go/no-go) |
| §10.4 | Slot-disk hazard | `workers/slot-monitor.ts`, `migrations/002`, `lib/thresholds.ts` |
| §10.5 | Initial snapshot | Runbook (off-peak) |
| §11 | Segment join | `manifest/appendix-b.example.yaml`, `tests_weekly.sql` |
| §12.1–12.2 | Error handling + playbooks | `docs/runbooks.md` |
| §12.3 | Testing / correctness | `workers/reconcile.ts`, `snowflake/operations/tests_*.sql` |
| §12.4 | Observability + SLAs | `admin/pages/health.tsx`, `migrations/001/004` |
| §13 | Security / retention | `migrations/003` (PASSWORD NULL), `manifest` retention, purge task |
| §14 | Rollout phases | `README.md` |
| §14.6 | Deploy / rollback / decommission | `docs/runbooks.md` |
| §17 A | Table/column inventory | `manifest/appendix-a.yaml` |
| §17 B | Segment mapping | `manifest/appendix-b.example.yaml` |

## Open Phase-0 decisions still to pin (§16)

These are captured in `configSchema` / manifest placeholders and must be resolved
with the LF data team + DPO before production:

1. Mechanism (Openflow A / self-hosted B / SaaS C / Supabase Pipelines F) — §5.1
2. Target Snowflake account (same as Segment, or separate) — §3.2
3. Connector runtime + Supabase IPv4 add-on — §10.3
4. PII posture (PII-1 / PII-2) — §8.2
5. Erasure mechanism (hard / soft / anonymise) — §8.3
6. `BYPASSRLS` accepted under governance — §8.4
7. DPA to ride under, or draft one — §13
8. Retention defaults — §13
9. Segment `userId` = person UUID — §11
10. Conformance to crowd.dev/LFX — §9.3
11. On-call ownership — §12.4
12. Secret store + rotation — §13
13. STAGING materialisation (tables + MERGE default; dbt vs tasks) — §6
14. Appendix ownership — §14

---

## Requesting the Supabase Pipelines Snowflake destination (Option F)

Per §5.1 / §14 Phase 0, submit the request **now** so the option matures in
parallel — but keep Openflow (A) as the primary; do not gate on F. Note Option F
does **not** add a new data processor (Supabase already processes this data), so
it stays as clean on the DPA as A/B — the only blockers are availability and
Snowflake-sink maturity.

**How to request (do all three — they track in different places):**

1. **Supabase Dashboard.** Open the AAIF project (`ktkkanmhbygivyzzyfex`) →
   Integrations → **Pipelines** → create/preview a pipeline. The destination
   picker lists **Snowflake** as request-only / "coming soon" — register interest
   there so it's attached to the actual project ref.
2. **Supabase Support ticket** (Dashboard → Support/Help) — a written request the
   Supabase team can track and reply to with a timeline. Use the draft below.
3. **`supabase/etl` GitHub** — Pipelines is built on `supabase/etl`, whose
   Snowflake destination module is where sink maturity is tracked. Open/track an
   issue there so we're notified when it reaches parity with the BigQuery sink.

**Draft request text:**

> **Subject:** Request: Snowflake destination for Supabase Pipelines (managed CDC)
>
> Project ref: `ktkkanmhbygivyzzyfex` (region AWS us-west-1).
>
> We run production logical-replication CDC from this project into a Snowflake
> warehouse and would like to use **Supabase Pipelines** (public alpha) rather
> than operate our own connector. Today the managed Pipelines destination list
> only offers BigQuery; Snowflake is request-only.
>
> Please register our interest in the **Snowflake destination** and let us know:
> (a) current status / expected GA timeline; (b) whether it supports
> explicit-table publications (not FOR ALL TABLES), delete/update capture, and a
> direct (non-pooler) connection; (c) whether we can join an early-access cohort.
>
> Data governance context: destination is a Linux Foundation Snowflake account;
> the source carries member PII under an existing DPA, so we need scoped-table
> capture and delete propagation.

I can't submit this for you (it needs Supabase-authenticated access to the AAIF
project), but the text is ready to paste. Once submitted, record the ticket URL
in `README.md` and revisit at each Phase-0 review.
