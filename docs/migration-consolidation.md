# Migration consolidation — baseline reset for existing installs

Module migrations are being consolidated so each module's **initial** migration
reflects the table's final shape, with later "bolt-on" patches folded back in
and removed. Fresh installs simply get fewer, cleaner migrations and need no
action. **Existing installs need a one-time tracking reset**, because of how the
runner tracks applied migrations.

## Why a reset is needed

`@gatewaze/shared` records every applied migration in `public.module_migrations`
as `(module_id, filename, sha256(file_contents))` and enforces two rules on the
migrations listed in a module's `index.ts` `migrations` array:

1. A migration whose `filename` is already recorded is **skipped**.
2. If a recorded migration's file **content changed** (checksum differs), the
   runner aborts with `MIGRATION_CHECKSUM_MISMATCH` — "modified after being
   applied. Manual intervention required."

Consolidation edits the initial migration files (folding in columns/fixes), so
on a DB where they were already applied, rule 2 trips. Removed migrations are
harmless on their own (the runner only iterates the current array, so a dropped
filename is simply never re-checked), but their stale tracking rows are clutter.

## What consolidation guarantees

Every consolidated module was verified to produce a **byte-identical
`pg_dump --schema-only`** to the pre-consolidation migration chain (full-platform
differential test). So the *resulting schema is unchanged* — only the path to it
(the migration files) is shorter. That is what makes the reset below safe: the
consolidated migrations are idempotent (`CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`), so on an
already-migrated DB they are no-ops.

## Reset procedure (per deployment, run once after pulling consolidated modules)

For each consolidated module, reconcile `module_migrations` to the new files:

- **Re-point checksums** for migrations that still exist (their content changed),
  and
- **Delete tracking rows** for migrations that were removed.

The runner's reconcile already re-reads each module's `index.ts` array, so the
simplest robust reset is to clear the tracking rows for the affected modules and
let reconcile re-record them against the (idempotent) consolidated files:

```sql
-- Safe because consolidated migrations are idempotent and produce the same
-- final schema. Run for each consolidated module id, e.g.:
DELETE FROM public.module_migrations
WHERE module_id IN (
  'blog','cohorts','forms','surveys','structured-resources',
  'editor-ai-copilot','events','competitions','calendars','analytics'
  -- add module ids as more modules are consolidated
);
```

Then run the normal migrate step (`pnpm modules:migrate`). Reconcile re-applies
the consolidated migrations against the existing schema — every statement is a
no-op (objects already exist) — and re-records each `(module_id, filename,
checksum)` with the new checksums. No schema change occurs; the tracking table
is simply brought back in sync.

> Verify on a staging copy first. If a deployment has drifted from the migration
> chain (manual hotfixes, etc.), reconcile the schema before resetting tracking.

## Consolidated modules so far

| module | before | after | change |
|---|---|---|---|
| blog | 7 | 6 | content_category + triage/publish_state columns folded into 001 |
| cohorts | 2 | 1 | content_category folded into 001 |
| forms | 2 | 1 | content_category folded into 001 |
| surveys | 2 | 1 | dropped dead-no-op content_category (wrong table name) |
| structured-resources | 4 | 4 | rejection_reason/publish_state/status CHECK folded into 001 |
| editor-ai-copilot | 5 | 4 | dropped create-then-drop of canvas_ai_daily_tool_usage |
| events | 15 | 13 | content_category folded into 001; events_ck_enqueue fix folded into 005 |
| competitions | 7 | 6 | content_category folded into 001 |
| calendars | 17 | 14 | members_dynamic fix folded into 002; audience fixes superseded by 012 |
| analytics | 7 | 6 | auto-provision SECURITY DEFINER fix folded into 00006 |
