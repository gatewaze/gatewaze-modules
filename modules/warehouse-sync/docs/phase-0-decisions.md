# Phase 0 — Decision Record

Resolves the spec's §16 open questions and §14 Phase-0 gate. Dated 2026-08-06.
Each item is either **DECIDED** (pinned here, with evidence), **RECOMMENDED**
(a defensible default pinned pending a named owner's ratification), or **BLOCKED**
(needs data only the LF data team / DPO / Segment dashboard holds).

Two findings below overturn assumptions baked into the original spec and the
first-pass manifest — read them before anything else.

## Headline findings

### F1 — Segment `userId` is the LFID sub, NOT the person UUID  (§11, Q9) — DECIDED
`packages/portal/app/api/t/route.ts:82-97` sends `user_metadata.lfid_sub` as the
Segment `userId` (deliberate — LFX Unify keys on the LFID). The person UUID
(`people.id`) is never emitted. `supabase_user_id` and `email` ride as traits.
→ The join contract is rewritten in **`manifest/appendix-b.yaml`**: primary join
is Segment `supabase_user_id` trait ↔ `people.auth_user_id`; secondary is Segment
`user_id` ↔ a derived `people.lfid_sub`. **No tracking-SDK change needed.**

### F2 — The Appendix A manifest does not match the live schema — BLOCKED (Phase-2 gate)
The first-pass manifest was written speculatively. Verified against
`gatewaze/supabase/migrations/00003_people.sql` and the module registry:
- `people` has **no `deleted_at`** → deletes are **hard** (manifest says soft).
- `people` **profile fields** (`first_name`, `last_name`, `company`, `title`,
  `city`, `country`) are **not columns** — they live in `attributes` (jsonb).
- `people` really has `auth_user_id`, `phone`, `cio_id`, `attribute_timestamps`,
  `avatar_*`, `is_guest` — none in the manifest.
- Table **names are wrong**: `event_registrations`→`events_registrations`;
  `send_log`→`email_send_log` (+ `broadcast_sends`, `bulk_send_*`); `person_emails`,
  `events`, `newsletter_sends` need name/column verification.
→ Tracked as gap **G1**; this is the §8.1 production gate. See `gap-analysis.md`.

## Decisions

| # | Question (§16) | Status | Decision |
|---|---|---|---|
| 1 | Mechanism | **DECIDED** | Airbyte OSS, an in-cluster install (`docs/airbyte-deployment.md`). |
| 2 | Target Snowflake account | **RECOMMENDED** | Land `AAIF.RAW` in the **same** account/warehouse Segment feeds, so the §11 join is intra-account (no cross-account share). LF data team to confirm. |
| 3 | Connector runtime + IPv4 | **DECIDED** | Airbyte runs in-cluster; the Postgres source uses the Supabase **direct** endpoint. Confirm cluster egress can reach Supabase over IPv6, else enable the Supabase **IPv4 add-on** (go/no-go, §10.3). |
| 4 | PII posture | **DECIDED (PII-1)** | Plaintext in RAW, masked in STAGING. `people.attributes` is `masking: full` — audited (PR #68/#74) to nest email/phone/name/linkedin/address/coords **and web-push keys**. Break-glass role only for plaintext. |
| 5 | Erasure mechanism | **DECIDED (hard)** | AAIF has **no `deleted_at` and no anonymize routine** (verified). Erasure = row hard-delete → STAGING **tombstones with identifiers + derived hashes nulled** (§7.2.1, already implemented). **Action:** AAIF still needs a documented erasure procedure (gap G4). |
| 6 | `BYPASSRLS` accepted | **RECOMMENDED** | Accept for the `snowflake_reader` role (§8.4) so the initial snapshot isn't silently RLS-filtered. DPO to record acceptance. |
| 7 | DPA | **BLOCKED** | Two-party AAIF↔LF (no third-party processor — Airbyte is LF-operated). Legal to confirm an existing agreement covers it or draft one. |
| 8 | Retention | **DECIDED** | Spec defaults, pinned in the manifest: RAW 180d, STAGING current-state indefinite, tombstones 90d, OPERATIONS 30d. |
| 9 | Segment `userId` = person UUID | **DECIDED (no)** | See **F1**. Join contract corrected in `appendix-b.yaml`. |
| 10 | crowd.dev / LFX conformance | **DEFERRED** | Standalone `AAIF` database is sufficient for now; MARTS/LFX-Insights conformance is downstream (§9.3), out of scope. |
| 11 | On-call ownership | **RECOMMENDED** | Gatewaze owns the module + slot-monitor alerts; the LF data team owns Airbyte platform + Snowflake. Confirm the paging owner for slot-disk alerts (§12.4). |
| 12 | Secret store | **RECOMMENDED** | LF-standard external-secrets → k8s Secrets (Airbyte creds, `snowflake_reader` password, Snowflake key-pair). Rotation cadence: 90 days. |
| 13 | STAGING materialisation | **DECIDED** | Tables + incremental `MERGE`; core 15 min, large facts 30 min. **Snowflake Tasks** first (dbt optional, `snowflake/dbt/README.md`). |
| 14 | Appendix ownership | **DECIDED** | Appendix A + B live in this module (`manifest/`), owned by whoever maintains warehouse-sync; changes go through the four-step §8.1 process + `pnpm generate:sql`. |

## What Phase 0 does NOT clear

Phase 0 is a decision phase. It does **not** make the pipeline production-ready —
that needs the Phase-2 Appendix A reconciliation (**G1**) and the Phase-3 gates.
See `gap-analysis.md` for the concrete remaining work.

## Still-external confirmations (paste these to the owners)

1. **LF data team:** same Snowflake account as Segment? (Q2) · IPv6 egress to
   Supabase or IPv4 add-on? (Q3) · paging owner for slot-disk alerts? (Q11).
2. **DPO / legal:** PII-1 + `BYPASSRLS` acceptance (Q4/Q6) · DPA coverage (Q7).
3. **Whoever has Segment access:** fill the `segment_snowflake:` block in
   `appendix-b.yaml` from the Marketing Ops → Snowflake destination settings, and
   confirm `supabase_user_id` landed as a column on the identify/users table.
