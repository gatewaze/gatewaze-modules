# Webhooks

Mutation-driven outbound webhooks. When a subscribed content row changes, the module fires signed HTTP POSTs to deployed-theme `/api/revalidate` handlers and best-effort purges the Cloudflare CDN, so the next visitor sees fresh content. This is Layer 2 of the API cache-and-revalidation design.

## How It Works

The whole pipeline is data-driven, so adding a new content table requires no code changes to this module.

### Data model

**`webhook_subscriptions`** — outbound destinations, scoped by `(host_kind, host_id)` where `host_kind` is one of `site` / `list` / `newsletter` / `global` and `host_id` is `text` (so future hosts can key by slug, int, or the well-known global UUID without a migration). Each row holds a `url`, an optional `topics` filter (empty = all topics for the host), an HMAC `secret` (plus `secret_previous` kept for 24h after rotation), a `status` (`enabled` / `disabled` / `suspended`), and failure bookkeeping. `consecutive_failures` auto-flips the status to `suspended` at 10 (handled in the hub so failure context is logged first).

**`webhook_event_topics`** — a lookup keyed by table name that drives the shared trigger. Each row maps a table to a `host_id_column` (NULL = a global, cross-tenant topic), a literal `surrogate_key_template`, an optional `detail_key_template`, and a `notify_columns` array of fields to materialise into the NOTIFY payload. Adding a module's table to the fan-out is just an `INSERT` here plus a `CREATE TRIGGER` on that table.

**`webhook_deliveries`** — an append-only delivery log. Rows sharing an `event_id` correspond to one mutation fanning out to N subscriptions. Each row tracks `status` (`pending` / `sent` / `failed` / `permanently_failed` / `skipped`), `attempt_count`, `next_retry_at`, the last response, and a `retention_until` (30 days) used by the purge.

All three tables have RLS enabled. `service_role` bypasses; authenticated admins read subscriptions/deliveries for hosts they administer via `webhooks_can_admin_subscription(...)`, which defers to the platform `is_platform_admin()` helper or `can_admin_site()` when present. The `secret` column is masked (`<redacted>`) in API responses except at creation, enforced in the route handler.

### Mutation flow

1. A subscribed table fires the shared `emit_mutation_event()` trigger on INSERT/UPDATE/DELETE. It looks up the table's config in `webhook_event_topics`, materialises the declared `notify_columns` (reading from `OLD` on DELETE — the only way to capture e.g. a slug before the row is gone), and calls `pg_notify('gatewaze.mutation', ...)`. Because NOTIFY fires at transaction commit, rolled-back transactions never leak events.
2. The **LISTEN worker** (`lib/listen-worker.ts`) holds a long-lived `pg` client subscribed to the `gatewaze.mutation` channel, reconnecting with exponential backoff (1s → 30s). On (re)connect it runs a recovery sweep so in-flight `pending` deliveries are not lost across a restart.
3. The **Webhook Hub** (`lib/webhook-hub.ts`) coalesces events within a 200 ms window keyed by `(host_kind, host_id)`, unioning their surrogate-key sets into one POST per matching subscription. It inserts a `pending` delivery row *before* each POST, signs the payload, and sends it. Failures retry with exponential backoff (30s / 2m / 10m / 1h / 6h / 24h) and suspend the subscription after 10 consecutive permanent failures. Finally it best-effort purges the unioned surrogate keys from the Cloudflare zone.

### Signing

Each POST is signed HMAC-SHA256 over `${unixSeconds}.${rawBody}`. The signature rides in `X-Gatewaze-Signature` (hex) alongside `X-Gatewaze-Timestamp`. Subscribers must verify the timestamp is within 5 minutes of now to prevent replay.

### Admin surface

Admin routes mount under `/api/admin/sites/:siteId/webhook-subscriptions` — list, create, patch, delete, `rotate-secret`, and `test`. A Webhooks tab appears at the bottom of the admin nav group. The module's `apiRoutes` hook both mounts these routes and starts the LISTEN worker for the process lifetime; `onDisable` stops the worker.

## Configuration

This module has no `configSchema`. The fan-out worker reads connection and purge settings from the environment:

| Variable | Purpose |
|---|---|
| `SUPABASE_DB_URL` / `DATABASE_URL` / `POSTGRES_URL` | Direct Postgres connection for the LISTEN worker (first one set wins). If none is set, the worker is disabled and Layer-2 fan-out does not fire — themes still refresh via TTL revalidation. |
| `CLOUDFLARE_API_TOKEN` | Token for best-effort CDN cache purge (optional). |
| `CLOUDFLARE_ZONE_ID` | Cloudflare zone to purge (optional). |

Migrations seed only the trigger function and the three tables. Each content module installs its own row in `webhook_event_topics` and a `CREATE TRIGGER ... emit_mutation_event()` on its table.

## Features

- `webhooks` — Core mutation-driven fan-out: the shared NOTIFY trigger, LISTEN worker, signing, retry/suspension, and Cloudflare purge.
- `webhooks.manage` — Admin UI and API for creating, editing, rotating secrets on, and testing webhook subscriptions.

## Dependencies

None. There is no hard dependency on `sites` — global topics do not require sites to exist. Modules that wire site-scoped triggers depend on `sites` themselves.
