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

## Features

- `compliance` — Core compliance dashboard and the `compliance_*` schema.
- `compliance.consent` — Consent record capture and audit trail (including anonymous consent inserts).
- `compliance.privacy_requests` — Data subject access / erasure / portability request handling.
- `compliance.data_breaches` — Breach incident tracking and affected-person notification.
- `compliance.audit` — Audit-oriented compliance records (processing-activity register, cross-border transfer register, and the consent/breach audit trails).

## Dependencies

None declared. The module extends the platform's existing `people` table directly and relies on the shared `is_admin()` and `set_updated_at()` helpers rather than depending on another module.
