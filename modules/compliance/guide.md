# Compliance

Privacy and data-protection tooling covering GDPR, CCPA/CPRA, and SOC 2 needs: consent records, data subject privacy requests, data breach tracking, a processing-activity register, cross-border transfer records, and per-person privacy preferences. Everything is surfaced in a single tabbed admin page at `/admin/compliance`.

## How It Works

The module's single migration extends the existing `people` table with privacy columns and creates a set of `compliance_*` tables. All compliance tables are RLS-protected: read and write require `is_admin()`, with one deliberate exception — anonymous visitors can INSERT consent records (cookie/GDPR consent) without authentication.

### Per-person privacy fields (on `people`)

The migration adds privacy-relevant columns directly to `people` rather than a side table, so they travel with the person record:

- **Policy acceptance** — `privacy_policy_accepted_at` / `privacy_policy_version`, `terms_accepted_at` / `terms_version`.
- **Data lifecycle** — `data_retention_expires_at`, `anonymized_at`, `deletion_requested_at`, `deletion_scheduled_for`.
- **CCPA / CPRA preferences** — `do_not_sell`, `do_not_share`, `limit_sensitive_data_use` (each with a `_set_at` timestamp), and `ccpa_opt_out_of_financial_incentive`.
- **Age verification / COPPA** — `date_of_birth`, `age_verified_at`, `age_verification_method`, `is_minor`, parental-consent fields, and `coppa_verifiable_parental_consent`.
- **Jurisdiction / residency** — `jurisdiction_country`, `jurisdiction_state`, `applicable_privacy_laws[]`, `data_residency_requirement`.

### Compliance tables

| Table | Purpose |
|---|---|
| `compliance_consent_records` | GDPR consent audit trail — `consent_type`, `consented`, the `consent_text` shown, plus `ip_address` / `user_agent` and `consented_at` / `withdrawn_at`. Linked to a `person_id` when known, always carries the `email`. |
| `compliance_privacy_requests` | Data subject requests — `request_type` (export, deletion, correction, portability, consent withdrawal, processing restriction) moving through `status` (`pending` -> `in_progress` -> `completed` / `rejected`), with `result_summary`, `notes`, and `processed_by`. |
| `compliance_data_breaches` | Breach incident records — `severity`, `status` (`detected` -> `investigating` -> `contained` -> `resolved` -> `reported`), affected data types and record counts, authority reporting, root cause, remediation, and lessons learned. |
| `compliance_data_breach_affected_people` | Junction linking a breach to affected `people` rows, with per-person notification timestamp and method. |
| `compliance_processing_activities` | GDPR Article 30 register — purpose, legal basis, data categories/subjects, recipients, retention, DPIA tracking, third-country transfer flags, and joint-controller details. |
| `compliance_cross_border_transfers` | Register of international transfers — destination, recipient type, transfer mechanism, adequacy decision / SCC / BCR flags, derogation basis, risk assessment, and supplementary measures. |

Mutable tables carry `created_at` / `updated_at` with a `set_updated_at` trigger.

### Admin surface

`/admin/compliance` renders a single page with six tabs, one per area: Privacy Requests, Data Breaches, Consent Records, CCPA Preferences, Processing Activities, and Cross-Border Transfers.

## Configuration

This module has no per-deployment config (`configSchema` is empty).

## Erasure (GDPR Art. 17)

A privacy request of type `data_deletion` can be carried out from the Privacy Requests tab, the public API or MCP. It always runs in two steps.

1. Preview. The engine finds every identifier for the person: the request addresses, other addresses recorded on the same person (`attributes.other_emails`, `person_emails`, `people_merge_audit`), profiles, registrations, sign-in accounts, Customer.io ids, phone numbers and Slack ids. It then counts the rows it would touch in each table. Nothing changes.
2. Erase. Needs a preview less than 24 hours old with no blockers, and the caller types one of the request addresses to confirm. Everything runs in one transaction, which either completes or rolls back. Afterwards the worker deletes the sign-in accounts, calls Customer.io and SendGrid, refreshes materialized views, and builds a checklist of manual steps (Luma, Gradual, Slack, Segment, Stripe). When every step is done, the request is completed and its addresses are replaced with sha256 hashes.

### Where personal data lives

`compliance_personal_data_registry` lists every table that holds personal data, how to match a person's rows, and whether erasure deletes them or anonymises them (keeps the row, clears the identifiers). Migration 003 registers core and the open source modules. A module in another repository registers its own tables from one of its migrations:

```sql
DO $$
BEGIN
  IF to_regprocedure('public.compliance_register_personal_data(jsonb)') IS NOT NULL THEN
    PERFORM public.compliance_register_personal_data('{"table":"podcast_guests","owner":"podcasts","action":"delete","person":["person_id"],"email":["email"]}');
  END IF;
END $$;
```

Keys: `table`, `entry`, `owner`, `action` (`delete` / `anonymise` / `ignore`), `person`, `profile`, `registration`, `auth`, `cio`, `email`, `email_array`, `phone`, `json_email`, `parent`, `clear`, `replace`, `covers`, `retain`, `note`, `order`. See the header of migration 003 for how to choose an action.

The engine fails closed. The preview stops the erasure if the person has rows in a table that links to `people`, `people_profiles` or `events_registrations` without a registry entry, or in an unregistered column that looks like an email address. `compliance_erasure_coverage()` lists every personal-looking column no entry covers, and `compliance_registry_missing_columns()` lists registry entries that name a column this database doesn't have (usually a module whose later migrations haven't run here). The admin API returns both at `GET /api/modules/compliance/coverage`.

### Suppression

Every erased address is stored in `compliance_suppressions` as an HMAC-SHA256 of the lowercased, trimmed address, with no other data. The key is generated once into Supabase Vault (`compliance_suppression_hmac_key`), or into the locked `compliance_hmac_key` table where Vault isn't installed, and isn't sent to application code (a database owner can still read it). Rotating it un-suppresses every erased address.

The suppression stops us or a third party adding the person again: the send engine skips suppressed recipients (it asks `compliance_suppressed_emails()`), and a trigger on `list_subscriptions`, `email_subscriptions` and `calendars_members` refuses to subscribe a suppressed address, whatever source or metadata the row claims and whoever writes it.

The person can sign up again themselves. The only way to lift a suppression is `compliance_lift_suppression(email, 'double_opt_in')`, which the newsletter sign-up function calls after the person confirms a link emailed to that address, proving they control the mailbox. A signed-in sign-up for a suppressed address is sent through that emailed confirmation too, since accounts can be created without proving the address. The trigger never lifts anything, because signed-in users and some service-role endpoints can put any source or metadata on a subscription row.

### Retention

Completed and rejected requests are deleted 30 days after they close, by the sweep (`compliance_purge_requests(30)`). The privacy team keeps the master record of each request. Suppressions stay after their request is deleted.

### Public API and MCP

Routes under `/api/v1/privacy`:

| Route | Scope |
|---|---|
| `POST /requests` | `compliance:write` |
| `GET /requests?email=`, `GET /requests/:id`, `GET /requests/:id/report` | `compliance:read` |
| `POST /requests/:id/preview` | `compliance:write` |
| `POST /requests/:id/execute` | `compliance:erase` |

Callers outside the admin see table names and row counts, never rows, and only counts of the identifiers the preview discovered. Keep `compliance:erase` separate from the other two so a key that can file requests can't delete data.

The preview and the erasure run in the `compliance:erasure` worker over a direct Postgres connection (`SUPABASE_DB_URL`, `DATABASE_URL` or `POSTGRES_URL`), because they scan tables too large for PostgREST's statement timeout. The `compliance-erasure-sweep` cron runs every minute and picks up anything queued, so requests filed through the public API work even where that API has no job queue.

### Testing

`__tests__/sql/erasure.test.sql` seeds a person, previews, erases and checks the result inside a transaction that is rolled back:

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f modules/compliance/__tests__/sql/erasure.test.sql
```

## Features

- `compliance` — Core compliance dashboard and the `compliance_*` schema.
- `compliance.consent` — Consent record capture and audit trail (including anonymous consent inserts).
- `compliance.privacy_requests` — Data subject access / erasure / portability request handling.
- `compliance.data_breaches` — Breach incident tracking and affected-person notification.
- `compliance.audit` — Audit-oriented compliance records (processing-activity register, cross-border transfer register, and the consent/breach audit trails).

## Dependencies

None declared. The module extends the platform's existing `people` table directly and relies on the shared `is_admin()` and `set_updated_at()` helpers rather than depending on another module.
