# Event Invites

Invite people to events with grouped RSVP, per-person event assignment, configurable follow-up questions, short links, QR codes, and multi-channel delivery. Supports weddings (day/evening), conferences (main event/workshops), and any scenario where different guests attend different parts of an event.

## How It Works

### Parties & Members

Invitations are organised into **parties** (couples, families, individuals). Each party has a **lead booker** who receives the invite link and manages RSVPs for everyone in the group. Party members can be added individually (with person search) or imported via CSV.

Each party gets a unique **short code** (8 characters) used to generate short RSVP links suitable for SMS, printed invitations, and QR codes.

### Sub-Events

Events can optionally have **sub-events** (e.g., "Day Ceremony" and "Evening Reception" for a wedding, or "Main Stage" and "Workshop A" for a conference). Each party member is assigned to specific sub-events. If no sub-events are configured, members are simply assigned to the parent event.

RSVP questions and deadlines are configured per sub-event, so day guests can be asked about meal preferences while evening-only guests see different questions.

### RSVP Flow

1. Admin creates a party and assigns members to events/sub-events
2. The invite is sent via email (or SMS/WhatsApp if those modules are installed)
3. The lead booker clicks the short link or scans the QR code
4. They're taken to the event page with an "RSVP" tab in the sidebar
5. The RSVP page shows all party members with their event assignments
6. The lead booker selects attend/decline per person per event and answers follow-up questions
7. If plus-ones are allowed, the lead booker can add additional guests
8. Responses are submitted and visible in the admin dashboard

### Admin Features

The module adds an **Invites** tab to the event detail page with:

- **Party list** with RSVP status, member counts, and short codes
- **Create Party modal** with individual person search and CSV import
- **Sub-Event configuration** panel for defining event parts
- **Question configuration** panel with per-sub-event tabs
- **Response dashboard** with aggregated summaries and CSV export
- **QR code export** for individual or bulk download
- **Reminder configuration** for automated RSVP reminders
- **Send controls** for triggering invite delivery

### Portal Integration

When a guest visits their invite link, the RSVP appears as a tab within the event page. They can browse the event details, speakers, agenda, and other pages while maintaining access to their RSVP. The RSVP tab only appears for users with an active invite token.

## Configuration

No configuration settings are required. The module uses the bulk-emailing module for email delivery. For SMS or WhatsApp delivery, install the `twilio-sms` or `whatsapp` modules.

## Features

- `event-invites` -- Core invitation and party management
- `event-invites.manage` -- Create, send, and manage invite parties with sub-event assignment
- `event-invites.analytics` -- Track delivery, opens, RSVP responses, and question answers

## Dependencies

- **events** -- Requires the events module for event association
- **bulk-emailing** -- Requires the bulk emailing module for sending invite emails

## Template System

The module includes a full template system for customising invite content across different channels.

### Template Types

- **PDF (Print)** -- Upload a Canva-designed PDF background, upload custom fonts, and position dynamic fields (party name, RSVP link, QR code) visually. Generate branded print-ready invitations per party.
- **Email** -- HTML email template with subject line and body. Uses `{{variable}}` syntax for dynamic content.
- **SMS** -- Plain text template with character count awareness.
- **WhatsApp** -- Template name and variables for WhatsApp Business API.

### Template Variables

Templates use `{{scope.field}}` syntax. Available variables include:

- `{{party.name}}`, `{{party.member_names}}`, `{{party.member_count}}`
- `{{invite.rsvp_link}}`, `{{invite.rsvp_code}}`, `{{invite.rsvp_display_url}}`
- `{{event.title}}`, `{{event.date}}`, `{{event.location}}`
- `{{sub_event.name}}`, `{{sub_event.time}}`, `{{sub_event.date}}`, `{{sub_event.description}}`
- `{{lead.first_name}}`, `{{lead.last_name}}`, `{{lead.email}}`

### Per-Sub-Event Templates

Each sub-event can have its own template per channel. When sending or printing, the system automatically matches the correct template based on the party's sub-event assignments. If no sub-event-specific template exists, the default (no sub-event) template is used.

### Multi-Channel Delivery

Parties can receive invites via ALL channels, not just one. Each delivery is tracked in the delivery log with channel, template used, status, and timestamp. The admin can print invitations, then send email reminders, then follow up with SMS — all tracked per party.

## Optional Integrations

- **twilio-sms** -- Enables SMS invite delivery when installed
- **whatsapp** -- Enables WhatsApp invite delivery when installed
