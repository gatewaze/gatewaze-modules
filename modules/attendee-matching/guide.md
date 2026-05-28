# Attendee Matching

AI-powered 1:1 attendee matching for pre-event networking introductions. The module uses Claude AI to optimally pair event registrants based on job title, company, and seniority, then sends personalised introduction emails to each pair before the event.

## How It Works

The module adds a **Matching** tab to the event detail page in the admin interface:

- **Generate matches** — Claude AI analyses all confirmed registrants and creates optimal 1:1 pairings. It avoids same-company pairs, scores each match on conversation potential, and determines the correct article ("a", "an", "the") for each person's job title.
- **Email settings** — Configure the from address, reply-to, subject, and message body. A rich text editor supports template variables for personalisation. Load saved email templates or start from scratch.
- **Preview & test** — Preview rendered emails per pair and send test emails to yourself before going live.
- **Bulk send** — Send introduction emails to all matched pairs in batches with progress tracking.
- **Match table** — View all pairs with scores, reasons, and email status. Click a row to expand the AI's reasoning for the pairing.

### Matching Algorithm

1. Fetches confirmed registrants (excludes sponsor, speaker, and staff ticket types)
2. Filters out registrants with placeholder data (N/A, TBD, etc.)
3. Sends attendee list to Claude AI for optimal pairing
4. Validates AI output: rejects out-of-bounds indices, self-pairs, and duplicates
5. Detects and fixes same-company violations by swapping partners between pairs
6. Greedy fallback pairing for anyone the AI missed
7. Stores matches in `events_attendee_matches` with scores and reasons

### Email Template Variables

| Variable | Description |
|----------|-------------|
| `{{person_a_first_name}}` | First name of person A |
| `{{person_b_first_name}}` | First name of person B |
| `{{event_title}}` | Event title |
| `{{event_weekday}}` | Day of the week (e.g. "Tuesday") |
| `{{event_link}}` | Event URL |
| `{{person_a_job_title}}` | Person A's job title |
| `{{person_a_company}}` | Person A's company |
| `{{person_b_job_title}}` | Person B's job title |
| `{{person_b_company}}` | Person B's company |
| `{{preceding_word_a}}` | Article for person A's title (a/an/the) |
| `{{preceding_word_b}}` | Article for person B's title (a/an/the) |
| `{{match_reason}}` | AI-generated reason for the pairing |

## Configuration

| Setting | Type | Required | Description |
|---------|------|----------|-------------|
| `ANTHROPIC_API_KEY` | secret | Yes | Anthropic API key for AI match generation |
| `SENDGRID_API_KEY` | secret | Yes | SendGrid API key for sending introduction emails |
| `MATCH_EMAIL_FROM_ADDRESS` | string | No | Default from address for match intro emails |

## Features

- `attendee-matching` — Core matching UI and generation
- `attendee-matching.generate` — Generate AI-powered matches
- `attendee-matching.emails` — Send introduction emails to matched pairs

## Dependencies

- `events` — Requires the events module for registrations and event data
