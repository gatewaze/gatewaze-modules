# Bulk Emailing

Send transactional and bulk emails to event registrants, speakers, attendees, and custom segments with full lifecycle tracking, automatic retries, and bot-filtered engagement analytics.

## How It Works

### Batch Job Pipeline

1. **Create a job** from the event Communications tab — choose recipients (registrants, speakers, attendees, etc.), compose subject and body using template variables, and hit Send.
2. **Processing** — the `email-batch-send` function processes recipients in batches of 50, sending each email through the configured email provider sub-module (e.g., SendGrid).
3. **Lifecycle tracking** — every email is logged in `email_send_log` with timestamps for each stage: queued, sent, delivered, opened, clicked.
4. **Self-healing** — if a batch stalls (function timeout, network blip), a watchdog detects it within 5 minutes and automatically resumes from where it left off.
5. **Retries** — transient failures (rate limits, server errors) are automatically retried with exponential backoff (2 min, 8 min, 32 min). Permanent failures (invalid addresses) are marked immediately.

### Engagement Tracking

Every open and click event from the email provider's webhooks is stored as a raw interaction. If a bot detection sub-module is installed (e.g., `email-bot-detector-signals`), each interaction is scored for human likelihood, giving you both raw and human-filtered engagement metrics.

### Provider Abstraction

The module doesn't send emails directly — it delegates to whichever **email provider sub-module** is installed and active. This means you can switch from SendGrid to Amazon SES (or any other provider) without changing any core logic.

## Configuration

| Setting | Type | Required | Description |
|---------|------|----------|-------------|
| `EMAIL_PROVIDER` | string | No | Which provider sub-module to use. Defaults to `sendgrid`. Must match an installed `email-provider-*` module. |
| `EMAIL_BOT_DETECTOR` | string | No | Which bot detector sub-module to use. Defaults to `signals`. Leave empty to disable bot detection. |
| `BULK_EMAIL_FROM_ADDRESS` | string | Yes | Default sender email address for bulk sends. |
| `BULK_EMAIL_FROM_NAME` | string | No | Default sender display name. |

## Template Variables

Use `{{scope.field}}` syntax in email subjects and bodies. Supported scopes:

### `{{customer.*}}`
- `first_name`, `last_name`, `full_name`, `email`

### `{{event.*}}`
- `name`, `id`, `city`, `country`, `start_date`, `end_date`, `link`, `location`

### `{{speaker.*}}` (speaker email types only)
- `first_name`, `last_name`, `full_name`, `email`, `talk_title`, `talk_synopsis`
- `company`, `job_title`, `confirmation_link`, `edit_link`

### `{{calendar.*}}` (registration/reminder emails only)
- `google`, `outlook`, `apple`, `ics` — calendar invite links

### Default Values
Use the pipe syntax for fallbacks: `{{customer.first_name | default:"there"}}`

## Analytics Views

The module creates two database views for engagement analytics:

- **`v_campaign_engagement`** — per-campaign stats: total sent, delivered, bounced, raw opens/clicks, human-filtered opens/clicks, and open/click rates.
- **`v_recipient_engagement`** — per-recipient stats: total emails, delivery rate, human engagement count, and an engagement health score (0–100).

## Dependencies

- Requires the **Events** module (for recipient data).
- Requires at least one **email provider sub-module** installed and active (e.g., `email-provider-sendgrid`).
- Optionally uses a **bot detector sub-module** for engagement scoring.

## Database Tables

| Table | Purpose |
|-------|---------|
| `email_send_log` | Per-email lifecycle tracking (replaces legacy `email_logs`) |
| `email_interactions` | Raw open/click events with bot scoring |
| `email_interaction_scores` | Multiple bot detector scores for comparison |
| `email_batch_jobs` | Batch job state, progress, and watchdog fields |

## Scheduled Jobs (pg_cron)

| Job | Schedule | Purpose |
|-----|----------|---------|
| `email-job-watchdog` | Every 2 min | Detects stalled batch jobs and resets them |
| `email-job-resume` | Every 2 min (offset) | Re-triggers resumed jobs |
| `email-retry-failed` | Every 2 min | Retries failed individual emails with backoff |
| `email-interactions-anonymize` | Daily 3 AM | Clears IP/user-agent from interactions older than 90 days (GDPR) |
