# Speakers

(module id stays `event-speakers` for backwards compatibility — rebranded in v2.0.0)

Manage speaker profiles, bios, session assignments, talk submissions, and speaker communications. As of **v2.0.0** the module also supports **calendar- and platform-level talk pools**, so chapter organisers can collect speakers and talk offers continuously and put on an event when they have enough material.

## What's new in v2.0.0

- **Scope-aware talks** — `events_talks.scope` ∈ {event, calendar, platform}. A talk can exist attached to an event (the classic flow), attached to a calendar as a held offer, or as a platform-wide offer with no specific chapter yet.
- **Canonical speaker profiles** — one profile per person across the brand. `events_speaker_profiles.person_id` links to `people`; duplicates by email are soft-merged via `canonical_profile_id`.
- **Top-level Speakers admin page** at `/speakers` with a directory, cross-calendar talk pool, and per-speaker detail pages.
- **Calendar Speakers tab** injected into calendar admin detail pages — shows the calendar's talk pool with accept/decline/promote actions.
- **Promote-to-event flow** — calendar admins can attach a held talk to any upcoming event in one click, preserving the originating calendar via `origin_calendar_id`.
- **Portal `/calendars/[slug]/submit-talk`** — public talk submission form for anyone visiting a calendar microsite, with email confirmation and edit-via-token self-service.

## How It Works

Event Speakers adds a **Speakers** tab to the event detail view in the admin panel. Organizers can create speaker profiles, assign speakers to sessions, and manage the full speaker lifecycle from submission through confirmation. The module includes edge functions that handle speaker self-service workflows -- speakers can submit proposals, confirm their participation, update their profiles, and receive notifications, all through dedicated API endpoints and tracking links.

## Configuration

This module has no configurable settings.

## Features

| Feature Flag | Description |
|---|---|
| `event-speakers` | Core speaker profile and listing functionality |
| `event-speakers.manage` | Full speaker management (assign sessions, send communications) |

### Edge Functions

- **events-speaker-confirm** -- Handles speaker confirmation of their participation
- **events-speaker-submission** -- Processes individual speaker/talk submissions
- **events-speaker-submissions** -- Lists and manages submitted speaker proposals
- **events-speaker-tracking-link** -- Generates unique tracking links for speaker communications
- **events-speaker-update** -- Allows speakers to update their profile and session details
- **events-speaker-update-notify** -- Sends notifications when speaker information changes

## Dependencies

| Module | Required |
|---|---|
| `events` | Yes |
| `event-sponsors` | Yes |

## Speaker speaker kits (v2.1)

Once a talk is **confirmed**, the module automatically generates a per-speaker
**speaker kit** the speaker can use to promote the event:

- **Tracking link** — an umami redirect link (`https://<portal-host>/go/<event>-<speaker-name>`)
  pointing at the event's registration page with the legacy attribution UTMs
  (`utm_source=speaker`, `utm_medium=direct`, `utm_campaign=<speaker profile id>`),
  so registrations keep joining back to the speaker. Requires the `analytics`
  module's umami instance (`UMAMI_*` env on the worker) and `PORTAL_HOST`.
  This replaces the old Short.io speaker link.
- **Share images** — three branded cards (feed 1200×1200, story 1080×1920,
  link-preview 1200×630) rendered by the worker image's pinned Chromium
  (puppeteer-core, 2x + Lanczos downscale). Templates, brand colorways/
  lockups, and the event→brand mapping live in a git template repo
  (`SPEAKER_CARDS_TEMPLATE_REPO` config, e.g.
  `github.com/gatewaze/gatewaze-template-speaker-cards`) so designers
  iterate without a deploy — mapping rules like `title_contains: "finance"`
  pick each forum's colorway. The repo is fetched with a 10-min cache; the
  copies vendored in `templates/` are the always-works fallback (and the
  default Voice colorway applies when no rule matches or no repo is set).
- **Post text** — four LinkedIn-safe plain-text variants written by the
  `speaker-promo-posts` goose recipe + skill (gatewaze/lf-agents), embedding
  the tracking link. Degrades gracefully: if the `ai` module is absent or the
  run fails, the kit ships with images + link only.
- **Zip** — everything bundled at
  `media/speaker-promo-kits/<event>/<talk>/promo-kit.zip`.

Pipeline: the `event-speakers-promo-kit-sweep` cron (2 min) creates
`speaker_promo_kits` rows for confirmed talks of upcoming events, retries
bounded failures, and drives the `event-speakers:generate-promo-kit`
two-phase worker (build → poll text run → finalize). The portal's
"Promote your talk" checklist item reads the kit through
`/api/speaker-promo-kit` (edit-token capability auth) and shows the images,
copyable posts, the link, and the zip download.
