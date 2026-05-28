# Virtual Events

Host live virtual events with YouTube streaming and interactive real-time chat. Supports multi-track conferences with separate stages, each with its own YouTube stream and independent chat. Includes moderator tools for managing chat, and a presenter view for surfacing audience questions.

## How It Works

### Streaming

Events are streamed via **YouTube Live**. The admin configures one or more tracks/stages, each with a YouTube video ID. The portal embeds the YouTube player and hides YouTube's native chat, replacing it with Gatewaze's own real-time chat system.

Admins should disable YouTube Live Chat in YouTube Studio and add a link to the Gatewaze event page in the YouTube stream description to drive viewers to register and join the interactive chat.

### Multi-Track Support

Events can have multiple concurrent **tracks** (stages). For example, a conference might have "Main Stage", "Workshop Room A", and "Workshop Room B". Each track has:

- Its own YouTube stream (video ID)
- Its own independent chat
- Its own stream status (upcoming/live/ended/replay)

Viewers switch between tracks using a tab bar at the top of the live page. For single-track events, the track switcher is hidden automatically.

### Event Lifecycle

1. **Upcoming**: Before the scheduled start time, viewers see a countdown timer with days/hours/minutes/seconds. Chat may be open for early discussion.
2. **Live**: YouTube player is shown with the active stream. Chat is active. Multiple tracks may be live simultaneously.
3. **Ended**: YouTube player shows a replay (if enabled) or a "This event has ended" message. Chat becomes read-only.

The event status is controlled by the admin via the Live config tab. Per-track stream status can be set independently.

### Real-Time Chat

Chat is built on **Supabase Realtime** — messages are persisted to PostgreSQL and delivered in real-time to all connected viewers via Postgres Changes subscriptions.

**Viewer features:**
- Send text messages (max 1000 characters)
- React to messages with emoji (👍 ❤️ 😂 👏 🤔 🔥)
- Reply to specific messages (threaded)
- View pinned messages at the top of chat
- Switch between "Chat" and "Questions" tabs
- See featured questions surfaced by the presenter

**Chat controls:**
- **Slowmode**: Admin can set a cooldown (0–300 seconds) between messages per user
- **Chat toggle**: Admin can enable/disable chat at any time
- **Blocked users**: Moderators can mute users temporarily or permanently

### Questions

Messages ending with `?` are automatically tagged as questions. These appear in a dedicated "Questions" tab for viewers, and in the presenter's question queue sorted by reaction count.

A future `virtual-events-ai-summary` sub-module can replace this simple detection with AI-powered question classification.

## Admin Features

### Live Config Tab

The "Live" tab on the event detail page contains:

- **Event Timing**: Scheduled start/end times and event status toggle
- **Chat Settings**: Enable/disable chat, slowmode, reactions, questions, replay after end
- **Track Management**: Add/edit/remove tracks with YouTube video IDs and stream status

### Moderator Tab

The "Moderate" tab provides real-time chat moderation:

- **Track selector**: Choose which track's chat to moderate
- **Full chat feed** with real-time updates
- **Per-message actions**: Pin (sticky at top of chat), Delete (soft delete, hidden from viewers), Block User
- **Post as Team**: Send messages with an "Event Team" badge
- **Quick chat toggle**: Enable/disable chat without navigating to config
- **Blocked users panel**: View and unblock muted users

### Presenter Tab

The "Present" tab is a distraction-free view for reading while presenting:

- **Track selector**: Choose which track's questions to view
- **Question queue**: Questions sorted by reaction count (most popular first)
- **Surface button**: Highlight a question as "Featured" — shown prominently in viewer chat
- **Recent activity**: Last 10 messages for context
- **Pop-out mode**: Open in a standalone window for on-screen reading during presentation
- **Large readable font**: Optimised for reading at a glance while presenting

## Portal Page

The virtual event page appears in the event sidebar as "Live" (only when the module is enabled). Viewers must be **registered and signed in** to see the stream and participate in chat.

**Desktop layout**: YouTube player on the left (60%), chat panel on the right (40%). Track switcher at the top if multiple tracks exist.

**Mobile layout**: YouTube player stacked above chat.

## Data Model

| Table | Purpose |
|-------|---------|
| `live_event_config` | Per-event settings: timing, chat config, replay |
| `live_event_tracks` | Tracks/stages with YouTube video IDs |
| `live_chat_messages` | Chat messages per track with question/team/surfaced flags |
| `live_chat_reactions` | Per-user emoji reactions (one per user per message per type) |
| `live_chat_pinned_messages` | Messages pinned by moderators |
| `live_chat_blocked_users` | Users blocked from posting |

## Security

- **Viewer access**: Only registered attendees (confirmed/attended status) can see the stream and chat. Non-registered users see a "Register to watch" prompt.
- **Chat posting**: Requires authentication + registration + not blocked + chat enabled + slowmode compliance. Enforced via PostgreSQL Row Level Security.
- **Moderation**: Only admins can delete messages, pin messages, and block users.
- **Input sanitization**: HTML tags stripped and content length enforced via database triggers.

## Sub-Module Extension Points

The virtual-events module is designed for extensibility. Future sub-modules can hook into:

| Extension Point | Type | Purpose |
|----------------|------|---------|
| `live_chat_messages.moderation_flags` | Database (JSONB) | Sub-modules write auto-detection flags |
| `virtual-event:chat-toolbar` | Portal slot | Add toolbar buttons (e.g., "Create Poll") |
| `virtual-event:chat-sidebar` | Portal slot | Add sidebar panels (e.g., "Poll Results") |
| `virtual-event:above-chat` | Portal slot | Content above chat (e.g., active poll widget) |
| `virtual-event:moderator-tools` | Admin slot | Additional moderator tools |
| `virtual-event:presenter-tools` | Admin slot | Additional presenter tools |

### Planned Sub-Modules

- **`virtual-events-moderation`**: Auto-flag self-promotion, external links, profanity
- **`virtual-events-ai-summary`**: AI question extraction and rolling chat summary for presenters
- **`virtual-events-polls`**: Live audience polls during the stream
- **`virtual-events-breakout`**: Breakout room management for workshop segments

## Dependencies

- `events` module (required)
- YouTube Live (external — no API key needed, just video IDs)
