# Email Provider: SendGrid

SendGrid email delivery provider for the Bulk Emailing module. Handles sending emails via the SendGrid v3 API and processing delivery/engagement webhooks.

## How It Works

This module implements the `EmailProviderModule` interface from the Bulk Emailing module. When installed and active, all emails sent through the bulk emailing system are routed through SendGrid's API.

### Sending

Each email is sent individually via SendGrid's `POST /v3/mail/send` endpoint. The provider returns SendGrid's `x-message-id` header, which is stored in `email_send_log.provider_message_id` for matching against webhook events.

### Webhook Processing

SendGrid sends delivery and engagement events to the `email-webhook` endpoint. This provider module:

1. **Verifies** the webhook signature using ECDSA (if `SENDGRID_WEBHOOK_VERIFICATION_KEY` is configured)
2. **Normalizes** SendGrid's event format into the standard `NormalizedEmailEvent` format
3. Passes events to the core module for lifecycle updates and interaction tracking

### Supported Events

| SendGrid Event | Mapped To | Updates |
|---------------|-----------|---------|
| `delivered` | `delivered` | Sets `delivered_at`, status to `delivered` |
| `open` | `open` | Sets `first_opened_at`, creates interaction record |
| `click` | `click` | Sets `first_clicked_at`, creates interaction record |
| `bounce` | `bounced` | Sets `bounced_at`, bounce type/reason |
| `dropped` | `dropped` | Sets `dropped_at`, reason |
| `spamreport` | `spam_reported` | Sets `spam_reported_at` |

Events like `processed`, `deferred`, `unsubscribe`, and `group_*` are received but not mapped to lifecycle updates.

## Configuration

| Setting | Type | Required | Description |
|---------|------|----------|-------------|
| `SENDGRID_API_KEY` | secret | Yes | Your SendGrid API key. Must have Mail Send permissions. |
| `SENDGRID_WEBHOOK_VERIFICATION_KEY` | secret | No | Public key for verifying SendGrid signed event webhooks (ECDSA). Found in your SendGrid Event Webhook settings. **Strongly recommended for production.** |

## Setup Steps

1. **Install** this module from the Modules page and enable it.
2. **Set `SENDGRID_API_KEY`** in the module configuration.
3. **Configure SendGrid Event Webhook** in your SendGrid dashboard:
   - URL: `https://your-supabase-url/functions/v1/email-webhook`
   - Select events: Delivered, Opened, Clicked, Bounced, Dropped, Spam Reports
   - Enable Signed Event Webhook Requests and copy the verification key
4. **Set `SENDGRID_WEBHOOK_VERIFICATION_KEY`** with the key from step 3.
5. **Set `EMAIL_PROVIDER`** to `sendgrid` in the Bulk Emailing module config (this is the default).

## Retry Behavior

The provider classifies SendGrid API errors for the retry system:

| Response | Retryable? | Action |
|----------|-----------|--------|
| 2xx (success) | N/A | Email marked as `sent` |
| 429 (rate limit) | Yes | Retry with exponential backoff |
| 5xx (server error) | Yes | Retry with exponential backoff |
| 4xx (client error) | No | Marked as `permanently_failed` |
| Network error | Yes | Retry with exponential backoff |

## Switching Away from SendGrid

To switch to a different provider (e.g., Amazon SES):

1. Install the new provider module (e.g., `email-provider-ses`)
2. Change `EMAIL_PROVIDER` to `ses` in the Bulk Emailing module config
3. Disable this module (optional — you can keep it installed for reference)

Existing email logs and interactions are unaffected. The `provider` column in `email_send_log` records which provider sent each email.
