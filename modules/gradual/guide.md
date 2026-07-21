# Gradual Integration

Sync event registrations and attendance data with the Gradual platform. This integration module connects Gatewaze events to Gradual via webhooks and batch sync, allowing you to keep both systems in lockstep without manual data entry.

## How It Works

The module provides three edge functions that handle different aspects of the Gradual integration:

- **Sync** (`integrations-gradual-sync`) — Performs batch synchronization of registration and attendance data between Gatewaze and Gradual.
- **Webhook** (`integrations-gradual-webhook`) — Receives incoming webhooks from Gradual to process real-time updates.
- **Import History** (`integrations-gradual-import-history`) — Imports historical data from Gradual into Gatewaze.

When enabled, the module creates the necessary database tables via its migration and begins listening for sync and webhook events.

## Webhook setup

In the Gradual platform's webhook settings, point outgoing webhooks at:

```
https://<your-supabase-project>.supabase.co/functions/v1/integrations-gradual-webhook
```

The endpoint is deployed with `verify_jwt: false` (like all module edge functions), so Gradual can post to it without a Supabase token. It accepts these Gradual event types and applies each to Gatewaze:

- `userRegistersForEvent` / `userCancelsEventRegistration` — create / cancel an `events_registrations` row
- `userChecksInToEvent` / `userChecksinForEvent` / `userAttendsEvent` / `userUnChecksInToEvent` — record `events_attendance` (`check_in_method = 'gradual'`)
- `newUserIsCreated` / `userProfileUpdate` — upsert the `people` record
- `newEventIsPublished` — auto-create the event (idempotent by `gradual_eventslug`)
- `userRefersEventRegistrant` — referral tracking

If a registration arrives for an event that isn't in Gatewaze yet, it is queued in `integrations_gradual_pending_registrations` rather than dropped.

## Linking events

Registrations match to Gatewaze events by the **`events.gradual_eventslug`** column. Any event that should receive Gradual registrations must have this column set to the event's Gradual slug (e.g. `agentsinproduction2025`). Events created by the virtual-events scraper, admin, or the `newEventIsPublished` webhook should carry this slug; otherwise incoming registrations will queue as pending and not attach.

## Configuration

| Setting | Type | Required | Description |
|---------|------|----------|-------------|
| `GRADUAL_CLIENT_ID` | string | Yes | Gradual API client ID (used by batch sync) |
| `GRADUAL_BEARER_TOKEN` | secret | Yes | Gradual API bearer token for authentication (used by batch sync) |

## Features

- `gradual.sync` — Batch synchronization of registrations and attendance between Gatewaze and Gradual
- `gradual.webhooks` — Real-time webhook processing for instant updates from Gradual

## Dependencies

- **events** — Requires the events module to be installed, since registrations and attendance are tied to events.
- **luma** — The webhook and import-history functions reuse Luma's shared registration helper (`_shared/lumaRegistration.ts`), which resolves at deploy time from the luma module.
