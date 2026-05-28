# Calendars

Manage event calendars with discovery, CSV import, scheduling APIs, and granular admin permissions. Calendars act as curated collections of events with their own members, scraper integrations, invite tracking, and interaction analytics.

## How It Works

The module creates a rich set of database tables and functions:

**Calendars** (`calendars`) are the central entity, each with a unique auto-generated ID (CAL-XXXXXXXX), name, slug, description, branding (logo, cover image, color), visibility (public, private, unlisted), and optional Luma integration fields. Calendars can be associated with accounts and have JSON settings (including location metadata for city/region/country-level targeting).

**Calendar-Event Junction** (`calendars_events`) links events to calendars with metadata about how they were added (manual, scraper, import, API), featured status, and sort order.

**Calendar Members** (`calendars_members`) tracks subscribers and members with membership types (subscriber, member, VIP, organizer, admin), status tracking, email/push notification preferences, and Luma import metadata. Members can be linked by person ID or email.

**Scraper-Calendar Junction** (`scrapers_calendars`) allows web scrapers to automatically feed discovered events into calendars, with per-association auto-add settings.

**Admin Permissions** (`admin_calendar_permissions` and `admin_event_permissions`) provide granular access control. Admins can have view, edit, or manage permissions on individual calendars, with optional expiration dates. Event access is inherited from calendar permissions or granted directly. Helper functions (`can_admin_calendar`, `can_admin_event`, `get_admin_calendars`, `get_admin_events`) enforce these permissions throughout the system.

**Calendar Invites** (`calendars_invites`) track calendar add-to-calendar links sent to registrants, with click tracking per calendar client (Google, Outlook, Apple, ICS download).

**Calendar Interactions** (`calendars_interactions`) log detailed analytics for invite interactions including device type, browser, OS, country, and response time.

**Calendar Preferences** (`calendars_preferences`) store per-user settings like preferred calendar client, timezone, and reminder preferences.

Three Edge Functions provide APIs: `calendars-api` for general calendar operations, `calendars-discover` for event discovery, and `calendars-process-csv` for CSV event imports.

The admin interface includes a calendar list page, a detail page with tabs (overview, events, members, scrapers, permissions, settings), and services for calendar CRUD, membership management, and CSV import.

## Configuration

This module has no configurable settings in the config schema. Calendar-level settings are stored in the `settings` JSONB column and include location configuration.

## Features

- **calendars** -- Core calendar management (create, edit, delete, list)
- **calendars.discover** -- Event discovery and scraper integration
- **calendars.import** -- CSV-based event import
- Curated event collections with branding and visibility controls
- Granular admin permissions (view/edit/manage) with optional expiration
- Calendar membership tracking with multiple membership types
- Scraper integration for automatic event population
- Add-to-calendar invite links with per-client click tracking (Google, Outlook, Apple, ICS)
- Interaction analytics (device, browser, OS, country)
- Per-user calendar preferences (client, timezone, reminders)
- Luma calendar integration support
- Location-based calendar targeting (city, region, country, global)
- Calendar statistics (total members, total/upcoming/past events)
- RLS policies with calendar-level permission checks

## Dependencies

- **events** -- Provides event data and registrations
- **scrapers** -- Provides web scraper infrastructure for event discovery
