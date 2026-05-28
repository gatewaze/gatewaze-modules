# Engagement

Track member engagement, award badges, and surface leaderboards across the platform.

## How It Works

The engagement module is **passive** — it doesn't poll or scrape. Other modules emit signals via the `emit_engagement_signal()` SQL helper, which writes a row to the `engagement_outbox` table. A background worker drains the outbox, applies cooldown / daily-cap / idempotency rules, and inserts an `engagement_events` row with the awarded points.

This decoupling means:
- Source modules (events, calendars, conversations, etc.) never block on engagement
- Engagement can be installed/uninstalled without source-module impact
- Failed signal recordings are durable and replayable
- The outbox absorbs traffic spikes

### Key tables

| Table | Purpose |
|---|---|
| `engagement_outbox` | Append-only queue of pending signals from source modules |
| `engagement_events` | Append-only log of recorded engagement events with point values |
| `engagement_rules` | Admin-editable scoring rules per signal type |
| `engagement_badges` | Badge definitions (count / threshold / manual / first / streak) |
| `engagement_member_badges` | Earned badges per (person, calendar) |
| `engagement_badge_eval_queue` | Async badge evaluation queue |
| `engagement_calendar_settings` | Per-calendar leaderboard visibility, display name mode, etc. |
| `engagement_scores_calendar` | Materialised view of per-(person, calendar) totals |
| `engagement_scores_global` | Materialised view of platform-wide totals |

### Default scoring rules

| Signal | Points | Cooldown | Daily cap |
|---|---|---|---|
| `event.registered` | 5 | 0 | — |
| `event.attended` | 20 | 0 | — |
| `event.attended.first_time` | 25 | 0 | — |
| `calendar.joined` | 10 | 0 | — |
| `calendar.confirmed` | 5 | 0 | — |
| `media.contributed` | 5 | 0 | — |
| `talk.submitted` | 15 | 0 | — |
| `talk.accepted` | 50 | 0 | — |
| `conversations.posted` | 1 | 60s | 50 |
| `conversations.reaction_received` | 1 | 0 | 100 |
| `profile.completed` | 10 | 0 | — |

Rules are admin-editable in the `/engagement/rules` page. Changes apply to *new* events; historic rows are immutable (denormalised points on each row).

### Badge kinds

| Kind | rule_config |
|---|---|
| `first` | `{"signal":"event.attended"}` — awarded on first matching signal |
| `count` | `{"signal":"event.attended","count":10}` — after N matching signals |
| `threshold` | `{"min_points":1000}` — once total score crosses N |
| `manual` | `{}` — only awarded by admin |
| `streak` | `{"signal":"event.attended","weeks":4}` — N consecutive weeks |
| `project_scope` | `{"project_id":"<uuid>","min_points":50}` — contributed by the `ambassadors` module. Sums approved `ambassador_contributions.awarded_points` filtered to the given project (via `ambassador_contribution_projects`). |
| `ecosystem` | `{"distinct_projects":3}` — contributed by the `ambassadors` module. Awards once the person's approved contributions cover at least N distinct projects. |

The `project_scope` and `ecosystem` evaluators are wired up in
`functions/engagement-rollup/index.ts` and read directly from the
`ambassador_contributions` / `ambassador_contribution_projects` /
`ambassador_profiles` tables. The integration is SQL-level only — engagement
does not depend on the ambassadors npm package. The evaluators auto-disable
themselves on brands that haven't installed the ambassadors module (table
existence probe). See `migrations/006_ambassador_badge_kinds.sql` for the
CHECK-constraint widening and `spec-ambassadors-module.md` §5.6 + §9.2.

### Negative-points signals (reversals)

`engagement_events.points` has no positivity constraint — modules can register
signals that emit negative points to reverse a previous award without rewriting
history. The ambassadors module uses this for the
`ambassador.contribution.reversal` signal (registered in its
`migrations/005_engagement_wiring.sql`), emitted when an approved contribution
is un-approved (e.g. plagiarism discovered). The append-only log preserves the
original event; the reversal row offsets it. No engagement-module change is
required to support this — it is mentioned here because the pattern is
generally useful to other modules.

### Public leaderboards

Each calendar can opt in to a public leaderboard at `/calendars/[slug]/leaderboard` (sub-nav entry contributed by this module via the calendars sub-nav contract). The display name mode is configurable per calendar:
- `first_name_initial` (default): "Jane S."
- `username`: "@jane" (requires conversations module)
- `full_name`: "Jane Smith"
- `anonymous`: "Member 412"

Members can opt out of public leaderboards entirely via a profile setting.

## Configuration

This module has no settings in the config schema. All configuration is per-calendar via `engagement_calendar_settings` and per-signal via `engagement_rules`.

## Features

- `engagement` — Core engagement tracking
- `engagement.leaderboard` — Public leaderboards
- `engagement.badges` — Badge definitions and awards
- `engagement.rules` — Admin-editable scoring rules

## Dependencies

- **events** — required (signals from event registration / attendance)
- **calendars** — optional (per-calendar scoring + leaderboards)
- **event-media** — optional (`media.contributed` signal)
- **event-speakers** — optional (`talk.submitted`, `talk.accepted` signals)
- **conversations** — optional (`conversations.posted`, `conversations.reaction_received` signals)
