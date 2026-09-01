# Gap Analysis — landed code vs. production-ready

Dated 2026-08-06. What's in `main` versus what the spec requires before the
pipeline can run against real AAIF data. Grounded in the live schema
(`gatewaze/supabase/migrations/`) and the tracking relay
(`packages/portal/app/api/t/route.ts`), not assumptions.

## ✅ Landed and green (no action)

- Module committed + merged, CI tests passing (#73).
- API routes auth-gated + RLS on operations tables (#63).
- `people.attributes` masking audited and locked to `full` (#68/#74).
- Slot-disk safety monitor + alerting (§10.4), reconcile worker, Airbyte control
  plane (client/status worker/admin dashboard), generator, migrations, runbooks.

## 🔴 Blockers — must close before ANY real run

### G1 · Appendix A manifest ≠ live schema  (§8.1 production gate)
The manifest was written speculatively; verified mismatches:

| Manifest says | Reality (evidence) | Fix |
|---|---|---|
| `people` soft delete `deleted_at` | **no `deleted_at`** (`00003_people.sql`) | delete mode → `hard` |
| `people.first_name/last_name/company/title/city/country` columns | live in `attributes` (jsonb) — "Profile fields … stored in attributes" | derive via jsonb extract (G3) or drop |
| — | `people` has `auth_user_id`, `phone`, `cio_id`, `is_guest`, `avatar_*` | add (auth_user_id = join key; phone = direct/masked) |
| `event_registrations` | real: **`events_registrations`** | rename |
| `send_log` | real: **`email_send_log`** (+ `broadcast_sends`, `bulk_send_*`) | rename / re-scope |
| `person_emails`, `events`, `newsletter_sends` | exist but names/columns unverified | column-verify |

**Consequence:** the committed STAGING models (`snowflake/staging/people.sql`,
`send_log.sql`, `generated/*`) and `lib/reconcile-targets.ts` reference tables and
columns that **don't exist** → they would fail on first run. Nothing STAGING-side
is runnable until the manifest is reconciled column-for-column against the live DB
and STAGING regenerated. **This is the single biggest gap.** Owner: warehouse-sync
maintainer, Phase 2.

### G2 · Segment join keys not exposed in STAGING  (§11)
Per `appendix-b.yaml`: join is `people.auth_user_id` ↔ Segment `supabase_user_id`
(primary) and `people.lfid_sub` ↔ Segment `user_id` (secondary). Neither
`auth_user_id` nor a lifted `lfid_sub` is in STAGING today. Add both as non-PII
join-key columns. Depends on G3 for `lfid_sub` (it's inside masked `attributes`).

### G3 · Generator can't extract from jsonb  (code task)
`lib/sql-gen.ts` only supports the `sha256_join` derivation. Because AAIF keeps
profile fields **and** `lfid_sub` in `attributes` (jsonb), the generator needs a
new derived kind — `jsonb_extract` (`attributes:key::type`) — so STAGING can
surface typed, individually-maskable columns from jsonb without exposing the whole
blob. Blocks G1 and G2. ~½-day change + tests.

### G4 · No AAIF erasure procedure  (§8.3)
Hard-delete tombstoning is implemented warehouse-side, but AAIF has **no
`deleted_at` and no anonymize/erasure routine** in code. Define the erasure
procedure (manual delete → CDC propagates) and the marked test subject the weekly
delete-propagation test needs. Owner: platform + DPO.

## 🟠 Operational — needed to go live (no module code change)

### G5 · Segment Snowflake location unknown  (Appendix B)
`appendix-b.yaml → segment_snowflake:*` is `null`. Not in the repo (env has only
`SEGMENT_WRITE_KEY`); read it from the Segment "Marketing Ops" → Snowflake
destination settings and confirm `supabase_user_id` landed as a column. Blocks the
§11 join queries and the weekly identity-match test.

### G6 · Airbyte not deployed
`docs/airbyte-deployment.md` exists; the cluster install (full Helm, external
Postgres + private S3 + secrets) and the source→destination→connection
are not created. Confirm the RAW metadata columns (`_ab_cdc_deleted_at`, …) match
`AIRBYTE_RAW_META` once a real sync runs (**G9**).

### G7 · Snowflake not provisioned
`snowflake/terraform/` is reference HCL — contribute into `lfx-snowflake-terraform`
and apply (service-account key-pair, masking policies, optional network policy).

### G8 · Source prerequisites not applied
Migration `003` is opt-in and hasn't run on AAIF prod: publication + scoped roles
not created, `snowflake_reader` password not set, `max_slot_wal_keep_size` not
confirmed bounded (§10.4 control #3). Use the direct endpoint, not the pooler.

## 🟡 Follow-ups (before analyst publish, not before first run)

- **G9** · Confirm Airbyte Typing-&-Deduping RAW column names vs `AIRBYTE_RAW_META`.
- **G10** · Fill in the checksum-sampling daily test and un-stub the Segment
  identity-match weekly test (needs G5) in `snowflake/operations/tests_*.sql`.
- **G11** · Decide whether `broadcast_sends` / `bulk_send_*` join the scope
  alongside `email_send_log` for a complete "sends" picture (affects G1).

## Suggested order

1. **G3** (generator jsonb extract) → unblocks **G1/G2**.
2. **G1** (reconcile manifest, regenerate STAGING) — the big one.
3. **G7 + G8** (provision Snowflake + apply source prereqs) in parallel.
4. **G6 + G5** (deploy Airbyte, wire the connection, capture Segment mapping).
5. **G9/G10/G4** during the 7-day soak before analyst publish (§14 Phase 3 gate).
