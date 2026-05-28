# Conversations

Direct messages, channels, and real-time chat across calendars and events.

## How It Works

The conversations module provides a unified data model for all messaging surfaces on Gatewaze:

- **Direct messages** between any two signed-in members of the same brand
- **Calendar channels** — one default channel per calendar, joinable by signed-in calendar members
- **Event channels** — one default channel per event, joinable only by registered attendees
- **Group channels** — additional channels admins can create on a calendar
- **Admin channels** — private channels for moderators

All conversations share a single `conversations` table distinguished by a `kind` column. Messages, participants, reactions, blocked users, notifications, and reports all hang off this central entity.

### Key Tables

| Table | Purpose |
|---|---|
| `conversations` | The central entity. `kind` ∈ {dm, calendar_channel, event_channel, group_channel, admin_channel} |
| `conversations_messages` | All messages, soft-deletable, replyable, mentioned-tagged |
| `conversations_participants` | Explicit membership rows. Default channels also have *virtual* participants resolved at query time from `calendars_members` / `events_registrations` |
| `conversations_reactions` | Per-user emoji reactions, denormalised counts on the message |
| `conversations_blocked_users` | Per-conversation or brand-wide block list |
| `conversations_notifications` | Outbox for in-app + push delivery |
| `conversations_reports` | Moderator review queue (stub in v1) |
| `push_tokens` | Device registrations for the future native mobile app |

The `people_profiles.username` column is also added by this module — it's the foundation for `@-mentions` and a per-brand unique handle.

### Multi-Level Moderation

Conversations have a tiered moderation model:

| Tier | Who | Scope |
|---|---|---|
| Super-admin | `admin_profiles.role = 'super_admin'` | Every conversation in the brand |
| Calendar admin | `admin_calendar_permissions.permission_level IN ('edit','manage')` | The default channel for that calendar + group channels on it + every event channel for events linked via `calendars_events` |
| Event admin | `admin_event_permissions.permission_level IN ('edit','manage')` | The event's channel + group channels on the event |
| Channel moderator | `conversations_participants.role = 'moderator'` | That one conversation |
| DM participant | The two parties of a DM | Their own DM |

Super-admins do **not** have automatic access to DM contents. Brand-level `metadata.dm_audit_enabled = true` flag enables it, with audit logging.

### Real-Time

Messages are delivered in real-time via Supabase Realtime (`postgres_changes` subscription on `conversations_messages` filtered by `conversation_id`). Typing indicators use presence channels.

## Configuration

| Setting | Description |
|---|---|
| `default_slowmode_seconds` | Default slowmode for new channels |
| `dm_policy_default` | Brand-wide default DM policy: `shared_calendars`, `nobody`, `mods_only`, `everyone` |
| `dm_audit_enabled` | Whether super-admins can view DM contents (audit-logged) |
| `notification_retention_days` | How long to keep read notifications (default 30) |
| `deleted_message_retention_days` | How long to keep soft-deleted messages before hard delete (default 30) |

## Features

- `conversations` — Core conversation management
- `conversations.dms` — Direct messages
- `conversations.channels` — Channels (group, calendar, event)
- `conversations.calendar-channels` — Per-calendar default channels (requires `calendars` module)
- `conversations.event-channels` — Per-event default channels
- `conversations.notifications` — In-app + push notifications
- `conversations.usernames` — Username service for `@-mentions`

## Dependencies

- **events** — required (for `event_id` FK on event channels)
- **calendars** — optional (unlocks calendar channels)
- **engagement** — optional (emits `conversations.posted` and `conversations.reaction_received` signals)
- **virtual-events** — optional (Phase C consolidation)
