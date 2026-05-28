# Events

Core events management — create, manage, and run events with registrations, attendance tracking, and check-in. This is a foundational feature module: calendars, scrapers, and the public API all build on top of the data model it owns.

## How It Works

The module owns four core tables plus a set of integration columns that other modules extend.

**Events** (`events`) is the central entity. Each row carries a UUID `id`, a short human-friendly `event_id` (e.g. a 10-char code), title/description/listing fields, schedule (`event_start`, `event_end`, `event_timezone`), location (`event_city`, `event_country_code`, `event_region`, `venue_address`, `event_latitude`/`event_longitude`), branding (`event_logo`, gradient colors, featured image), and a large set of feature toggles (`enable_registration`, `enable_native_registration`, `enable_agenda`, `enable_call_for_speakers`, `walkins_allowed`, etc.). Provenance is tracked via `source_type`, `source_details`, `scraper_id`, and `event_source_url`. Integration columns support Luma, Meetup, and Cvent sync, custom domains, portal theming (`portal_theme`, `theme_colors`), and a `nearby_hotels` JSONB list rendered on the venue page.

**Registrations** (`events_registrations`) links a person to an event with a unique `(event_id, person_id)` constraint. It tracks `status` (pending / confirmed / cancelled / attended / no_show / waitlisted), `registration_type`, ticket/payment fields (`ticket_type`, `payment_status`, `amount_paid`, `currency`), marketing attribution, and arbitrary `registration_answers` / `registration_metadata` JSONB.

**Attendance** (`events_attendance`) records check-ins, optionally referencing a registration. It captures `check_in_method` (qr_scan / manual_entry / badge_scan / mobile_app / sponsor_booth), location, timestamps, and `sessions_attended`.

**Registration field mappings** (`registration_field_mappings`) map external/source registration form labels onto people attributes or registration fields, with a per-mapping transform.

### Publish state

Events flow through a publish-state machine that lives in the `content-platform` module. Migration `006_publish_state.sql` adds an `events.publish_state` column (`draft`, `pending_review`, `auto_suppressed`, `rejected`, `published`, `unpublished`), backfills it, and makes the legacy `is_live_in_production` a generated column derived from it. State transitions go through the platform RPC `content_publish_state_set('event', ...)`, wrapped by `events_publish_state_set(...)`.

### Optional adapter integrations

Several migrations register the events module as an adapter for sibling modules, and each is a no-op if the sibling is not installed:

- **Triage** (`004_triage_adapter.sql`) — registers approve / reject / suggest-categories / submit functions with `content_triage_adapters` so events can be reviewed in a moderation queue.
- **Keywords** (`005_keyword_adapter.sql`) — registers a `events_keyword_text(...)` adapter with `content_keyword_adapters` for keyword extraction and matching.
- **Host media** (`014_register_event_host_media.sql` + the `apiRoutes` hook) — registers events as a host-media consumer (`hostKind: 'event'`) with albums, sponsor tagging, YouTube, and ZIP unpack enabled, so the shared Media tab appears on the event detail page.

### APIs and surfaces

- **Admin REST** (`api.ts`, mounted by the platform) exposes events list/CRUD, distinct-column lookups, bulk delete, Luma-syncable listing, registrations CRUD, attendance (single and bulk), and CSV import/export.
- **Edge functions** (Deno): `events` (general operations), `events-registration` (public registration intake that upserts a person and creates a registration), `events-search` (faceted public search by month/region/type/topics), `events-generate-matches` (AI-assisted attendee matchmaking via the Anthropic SDK), and `events-send-match-emails` (delivers match intro emails via SendGrid).
- **Public API** (`public-api.ts`) serves read-only `GET /` (list with filters and sparse fieldsets), `GET /{id}`, `GET /{id}/speakers`, and `GET /{id}/sponsors`, gated by the `events:read` scope. Only events with `is_listed = true` are exposed.
- **MCP** (`mcp.ts`) contributes `search`, `get`, and `stats` tools, an "Upcoming Events" resource, and a `summarize` prompt.
- **Admin UI** adds an Events nav item and detail-page tabs (Hosts, Speakers, etc.), plus a `person-detail:events` slot showing a person's event history.

## Configuration

This module has no entries in its `configSchema` (it is empty). Per-event behavior is stored on the event row itself. The edge functions read deployment secrets from the environment:

| Variable | Used by | Purpose |
|---|---|---|
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | all functions | Service-role database access |
| `ANTHROPIC_API_KEY` | `events-generate-matches` | AI attendee matchmaking |
| `SENDGRID_API_KEY` | `events-send-match-emails` | Sending match intro emails |
| `SENDGRID_FROM_*` | `events-send-match-emails` | Per-audience fallback sender addresses (admin / events / members / partners / default) |

## Features

- `events` — Core event management: create, edit, list, publish, and run events.
- `events.registrations` — Registration intake and management, including ticket/payment metadata and field mappings.
- `events.attendance` — Check-in and attendance tracking with multiple check-in methods.

## Dependencies

- **content-platform** — Provides the publish-state machine, audit log, and the `content_publish_state_set` RPC that the events publish-state transitions call through.
