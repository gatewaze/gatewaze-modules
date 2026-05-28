# Umami Analytics

First-party, self-hosted analytics backed by Umami. The module auto-provisions a Umami "website" entry per Gatewaze site, portal, and external host; injects per-property tracking snippets; surfaces native dashboards (pageviews, sessions, cohorts, retention); and provides a generalised custom-script pipeline plus first-class Segment integration. No third-party SaaS, and no PII leaving the cluster.

## How It Works

The module's own schema lives in the `analytics` schema on the existing platform Postgres. Umami's own schema is bootstrapped separately by a Helm pre-install Job (it does not ship as a module migration).

### Properties — the unit of measurement

`analytics_properties` is the central entity. Each row has a stable `property_id` baked into the embed snippet (never rotated — archive and recreate if compromised), a `kind`, a `domains` origin allow-list, and a `website_uuid` filled in once Umami's matching `website` row exists.

| `kind` | Provisioning | Notes |
|---|---|---|
| `gatewaze_site` | Automatic | Linked to a host via `host_kind` + `host_id`; one property per host |
| `gatewaze_host` | Automatic | Same host-backed linkage |
| `portal` | Auto/managed | Exactly one portal property (enforced by a partial unique index) |
| `external` | Manual | Operator-registered; may use a `*` wildcard domain (the only kind allowed to) |

A property starts `status='pending'`; the embed snippet returns a no-op until the provisioning worker flips it to `active`. Read/write access is gated by `can_read_analytics_property()` / `can_admin_analytics_property()`, which dispatch to the host's own `can_admin` function for host-backed properties and require super-admin for portal/external.

### Provisioning pipeline

When an `analytics_properties` row is inserted as `pending`, it is picked up by the `analytics:provision-property` worker (driven by a 60-second cron). The worker calls Umami's REST API to create the matching `website` entity and writes the resulting `website_uuid` back to the row. It is idempotent on retry — Umami's `POST /api/websites` is idempotent on `(name, domain)`. A second daily cron (`analytics:share-token-rotation`) rotates Umami's read-only iframe share tokens; the schema and worker are wired up ahead of a future surface that uses them.

### Ingest and embed

Public endpoints are mounted at the root so they are same-origin with sites pages:

- `POST /a/collect` — the ingest endpoint. Rate-limited per-IP and per-property via sliding windows.
- `GET /a/:filename` — serves the per-property pixel/embed bundle, cached via `Cache-Control`.

Admin-side property and dashboard APIs are mounted at `/api/analytics` (and `/api/modules/analytics`).

### Tracking scripts and Segment

`analytics_tracking_scripts` holds per-property `script_head` / `script_body` raw HTML/JS blobs (Segment, GTM, Hotjar, LinkedIn Insight, etc.). By design these are **not** sanitised — the admin-role write boundary is the security contract, and read access is restricted to `service_role` so the renderer fetches them at request time. Segment is first-class: supply a per-property write key (stored encrypted in `analytics_secrets`) and the embed snippet generator wires it up. `analytics_custom_events` registers the event names each property emits (declared manually, by theme block definitions, or by the system).

### Three integration modes

- **Sites module pages** — automatic; the renderer injects the snippet for the page's resolved property.
- **Portal** — opt-in via brand config (the existing `platform_settings.tracking_head/body` keys keep working).
- **External sites** — manual copy-paste of a generated `<script>` tag.

### Admin surface

A top-level **Analytics** nav item lists properties and drills into per-property dashboards: a property list page, a dashboard page, and a settings page (`/analytics`, `/analytics/properties/:id`, `/analytics/properties/:id/settings`).

## Configuration

| Key | Required | Default | Description |
|---|---|---|---|
| `UMAMI_BASE_URL` | No | `http://umami:3000` | Internal Umami service URL. Defaults to the in-cluster Service from the bundled Helm chart; override only if running Umami separately. |
| `UMAMI_USERNAME` | Yes | — | Admin username for the Umami API. Created by the bootstrap Job; mirrored into a Kubernetes Secret. |
| `UMAMI_PASSWORD` | Yes | — | Admin password for the Umami API. Stored in the platform secrets store; never logged. |
| `ANALYTICS_RETENTION_DAYS` | No | `395` | Days of pageview/event data to retain (default 13 months). Pruned by a daily Helm CronJob. |
| `ANALYTICS_INGEST_PER_IP_RPM` | No | `200` | Per-IP rate limit on `/a/collect` (60s sliding window). |
| `ANALYTICS_INGEST_PER_PROPERTY_RPM` | No | `5000` | Per-property rate limit on `/a/collect` (60s sliding window). |
| `ANALYTICS_EMBED_CACHE_MAX_AGE_SECONDS` | No | `300` | `Cache-Control` max-age for the `/a/<property_id>.js` embed bundle. |

### Deployment modes

- **Bundled (default for self-hosted):** ships a Helm sub-chart that runs Umami as a single-replica Deployment against the existing platform Postgres — no Docker socket, no host filesystem, no Supabase CLI. A Helm pre-install Job bootstraps Umami's database.
- **Bring-your-own:** point `UMAMI_BASE_URL` at an existing Umami instance, supply `UMAMI_USERNAME` / `UMAMI_PASSWORD`, and leave the bundled chart's `enabled` value off.

## Features

- `analytics` — Core property registry, provisioning, ingest, and native dashboards.
- `tracking-scripts` — Per-property custom `script_head` / `script_body` injection pipeline.
- `segment-integration` — Per-property Segment write key configuration and snippet generation.

## Dependencies

None declared. The module integrates with the sites/portal renderers via property resolution rather than a hard module dependency. The storage backend is abstracted behind `analyticsService` so it can later be swapped (e.g. to ClickHouse / Tinybird) without touching consumer code.
