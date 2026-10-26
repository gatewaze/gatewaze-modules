# Cvent

Pushes event registrations to Cvent so badges can be printed on site. It works for every registration source (Luma webhook, Luma CSV upload, the portal form), because it reads the registrations table rather than hooking one importer.

## How it works

- A worker job runs every minute. For each event with live sync on, it pushes registrations that are not yet in Cvent: find or create the contact by email, then register the contact as an attendee with the event's admission item.
- When a person's first name, last name, job title or company changes after they were synced, the next run updates the contact in Cvent, so the badge shows the new details.
- Every attempt is recorded in `cvent_registration_sync`. Failures retry with a doubling delay (2, 4, 8 minutes, up to a day) and stop after 5 attempts; the last error shows in the admin tab.
- Each run has a time budget (50 seconds) and a batch size (100 per event). A large backfill is spread over a few runs.

Registrations with status `confirmed`, `pending`, `waitlist`, `waitlisted` or `attended` are pushed. Cancellations are not propagated to Cvent.

## Setup

1. Create a REST API OAuth client in Cvent (Admin → Integrations → REST API) with the contacts, attendees and admission-items scopes.
2. In the admin, open Modules → Cvent and enter the client id and client secret. The secret is sealed at rest.
3. Enable the module. This creates the ledger table and registers the worker job.
4. On the event, open the Cvent tab:
   - Paste the Cvent event id (the uuid from the Cvent event URL) and save.
   - Click Fetch to load admission items and pick the ticket type, or paste the admission item id. Save.
   - Use "Test with one registrant" to push a single person and check they appear in Cvent.
   - Click "Sync now" to push everyone already registered, then switch Live sync on.

If Fetch fails with a header-size error, the OAuth token Cvent issued is too large for their API gateway. Paste the admission item id by hand and ask Cvent support to raise the limit for your client.

## Configuration

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `CVENT_CLIENT_ID` | string | yes | OAuth client id |
| `CVENT_CLIENT_SECRET` | secret | yes | OAuth client secret, sealed at rest |
| `batch_size` | number | no | Registrations per event per run (default 100) |
| `budget_ms` | number | no | Time budget per worker run (default 50000) |

## Admin API

All routes are under `/api/modules/cvent` and require an admin bearer token.

- `GET /events/:eventId/settings` — the event's Cvent fields, sync counts and whether credentials are set
- `PUT /events/:eventId/settings` — save `cvent_event_id`, `cvent_event_code`, `cvent_admission_item_id`, `cvent_sync_enabled`
- `GET /events/:eventId/admission-items` — admission items from Cvent
- `GET /events/:eventId/registrants?q=` — registrants matching a name or email
- `POST /events/:eventId/sync-now` — one bounded sync batch
- `POST /registrations/:registrationId/sync` — push one registration

## Features

- `cvent` — the module
- `cvent.sync` — registration sync

## Dependencies

`events`.

## Upgrading from 1.x

Version 1 shipped an edge function (`integrations-cvent-sync`) and a database trigger written against the old `customers` / `member_profiles` tables; neither worked on the current schema. Version 2 removes both. If `integrations-cvent-sync` is still deployed on a Supabase project, delete it; nothing calls it. The Cvent card in the event-tracking module's Tracking tab moved here.
