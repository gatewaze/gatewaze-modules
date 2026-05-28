# Badge Printing & Scanning

Badge printing, QR code scanning, and contact exchange for events. This module provides the infrastructure for generating printed attendee badges with embedded QR codes and tracking contact scans between attendees at events.

## How It Works

The module creates five database tables that form the badge and scanning system:

**Badge Templates** (`events_badge_templates`) define the layout and content of printed badges. Templates specify paper size (62mm, 102mm, or custom), which fields to include (QR code, photo, company, title), and visual settings like background images and logos. Templates are categorized by type (standard, VIP, speaker, sponsor, staff).

**Badge Print Jobs** (`events_badge_print_jobs`) track batch printing operations. Jobs can be bulk pre-event prints, on-demand prints, reprints, or VIP batches. Each job tracks progress (queued, printing, completed, failed, cancelled) with counts for total, printed, and failed badges.

**Badge Prints** (`events_badge_prints`) record individual printed badges, linking a people profile to a print job with a unique 12-character QR code ID and hashed QR token. Each print tracks its type (pre-event, check-in, replacement, VIP) and print status.

**QR Access Tokens** (`events_qr_access_tokens`) store short-lived hashed tokens embedded in badge QR codes. These tokens provide secure, time-limited access to attendee profiles when scanned, with usage tracking.

**Contact Scans** (`events_contact_scans`) record QR-based contact exchanges between attendees. Each scan captures the scanner and scanned profiles, event context (personal, sponsor booth, speaker session, networking), and optional metadata like rating, interest level (hot/warm/cold), notes, tags, and follow-up flags. Scans are unique per scanner-scanned-event combination.

The admin interface provides pages for managing badge templates, monitoring print jobs, and viewing contact scan records. Supporting libraries handle QR code generation, badge layout rendering, and printer integration.

## Configuration

This module has no configurable settings.

## Features

- **badge-scanning** -- Core badge scanning and contact exchange
- **badge-scanning.templates** -- Badge template management (layout, paper size, content fields)
- **badge-scanning.printing** -- Print job management (bulk, on-demand, reprint, VIP batch)
- **badge-scanning.contact-scans** -- Contact scan tracking and reporting
- Customizable badge templates by attendee type (standard, VIP, speaker, sponsor, staff)
- QR code generation with short-lived, hashed access tokens
- Batch and on-demand badge printing with progress tracking
- Contact exchange between attendees via QR code scanning
- Scan context tracking (personal, sponsor booth, speaker session, networking)
- Interest level and follow-up flagging for scanned contacts
- Row-level security on all tables

## Dependencies

- **events** -- Provides event data, registrations, and people profiles
