# Competitions

Run competitions with entry submissions, judging workflows, winner selection, and attendee matching for events. This module adds competition/giveaway management, AI-powered attendee matching, per-event communication settings, and batch email capabilities.

## How It Works

The module creates several database tables and integrates deeply with the events system:

**Competitions** (`events_competitions`) define giveaways, raffles, contests, or quizzes tied to events. Each competition has a title, slug, description, prize description, type, status (draft, active, closed, completed), value, dates, max entries, rules, and optional sponsor association. Competitions support rich content fields (intro, content) and display ordering.

**Competition Entries** (`events_competition_entries`) track individual submissions from people, with JSONB entry data and status tracking (active, winner, disqualified).

**Competition Winners** (`events_competition_winners`) record selected winners with prize details, optional discount code awards, and notification/claim timestamps.

**Attendee Matches** (`events_attendee_matches`) store AI-generated matches between event registrants. Each match links two registrations with a match score, reason, status (pending, confirmed, rejected), and intro email tracking. This enables networking features where attendees are matched based on their profiles.

**Communication Settings** (`events_communication_settings`) provide per-event email configuration for multiple email types: registration confirmation, reminders, speaker workflow emails (submitted, approved, rejected, reserve, confirmed), post-event follow-ups (attendee and non-attendee), registrant outreach, and match introduction emails. Each email type has its own enabled flag, template ID, from address, reply-to, CC, subject, and content fields.

**Email Batch Jobs** (`email_batch_jobs`) track bulk email sends with progress counters (total, processed, success, fail) and error logging.

The module provides an Edge Function (`events-competition-entry`) for processing competition submissions from the public portal.

The admin interface includes competition management pages (list, detail, entries), plus two slot components that inject into event detail views: an EventCompetitionsTab for managing competitions within an event, and an EventMatchingTab for attendee matching. The competitions admin includes entry management with export and winner notification via email.

## Configuration

This module has no configurable settings.

## Features

- **competitions** -- Core competition management (create, edit, list, entries)
- **competitions.entries** -- Entry submission tracking and management
- **competitions.judging** -- Winner selection and notification workflows
- Multiple competition types: giveaway, raffle, contest, quiz
- Competition lifecycle management (draft, active, closed, completed)
- Entry data capture with JSONB flexible fields
- Winner selection with discount code award integration
- AI-powered attendee matching with scores and reasons
- Per-event email communication settings for 10+ email types
- Batch email sending with progress tracking
- Sponsor association for competitions
- Admin slot integration into event detail views (competitions tab, matching tab)
- Public competition entry via Edge Function
- Entry export and winner email notification

## Dependencies

- **events** -- Provides event data, registrations, and the event detail UI for slot injection
- **event-sponsors** -- Provides sponsor data for competition sponsorship (conditional FK)
- **discounts** -- Provides discount codes for winner prize fulfillment (conditional FK)
