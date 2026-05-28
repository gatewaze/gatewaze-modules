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
