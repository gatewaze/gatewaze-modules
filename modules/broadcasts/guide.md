# Broadcasts module

Send a **single scheduled, timezone-aware email or Slack message to a segment** (or contact
list, email only), with an **AI segment copilot** that turns a plain-language audience
description into a segment and attaches it. Email first; built channel-agnostic
so SMS / WhatsApp / in-app can be added later (spec-broadcasts-module.md).

## How it works

Broadcasts mirror the proven **newsletter send pipeline** — only the audience
*source* differs (a segment, not an edition + list) and unsubscribe is
*topic-scoped* (not per-list). It rides the same per-recipient timezone drip:

```
broadcasts:dispatch-scheduled (60s BullMQ cron, in-worker — no Edge round-trip)
   ├─ select status='scheduled' AND scheduled_at <= now() (LIMIT 10)
   ├─ per due send:
   │    ├─ recalc segment first (best-effort, freshness-windowed)
   │    ├─ fanout_broadcast_send_recipients(send)   -- materialise per-recipient
   │    │     • source = segments_memberships (or list_subscriptions)
   │    │     • send_at = target_local in each recipient's timezone (global = now())
   │    │     • EXCLUDES broadcast_suppressions (topic or 'all')  ← compliance
   │    │     • EXCLUDES exclude_sent_send_ids (prior sends, via sent_at)
   │    └─ flip broadcast_sends.status → 'sending' (or 'failed' on RPC error /
   │       0-deliverable-recipients)
   └─ drip tick (shared send engine): claim_due_broadcast_recipients(200) →
       batched provider.send → email_send_log
```

`global` sends fan out with `send_at = now()`; `tz_local` staggers per timezone.
Pause/resume/cancel = status flips on `broadcast_sends` (the claim is gated on
`status='sending'`).

## Slack broadcasts

A broadcast is created as **Email** or **Slack message** and can't change after.
A Slack broadcast sends a direct message to each person in its segment who is
linked to a Slack member (`people.attributes.slack_user_id`, written by the
slack module's member sync).

- **Audience.** Segment only. Email list subscriptions don't apply. The fan-out
  still skips anyone with a `broadcast_suppressions` row on topic `slack` or `all`
  (the global opt-out), outreach
  prospects unless the send includes them, people already sent by the chosen
  earlier sends, and (at send time) anyone erased by the compliance module. A
  Slack member linked to two people rows gets one message.
- **Content.** `broadcasts.body_text`, Slack mrkdwn, up to 4,000 characters.
  `{{first_name}}`, `{{name}}`, `{{company}}`, `{{job_title}}` are filled per
  recipient and escaped, so a profile value can't mention `@channel`. `{{event_*}}`
  variables are filled when the send is created. There is no unsubscribe link.
- **Sender.** The workspace bot (`SLACK_BOT_TOKEN` in the slack module, needs
  the `chat:write` and `im:write` scopes) or the account connected for welcome
  DMs. The Sending tab checks the bot token with `auth.test` and lists missing scopes.
- **Sending.** Sends are always created `scheduled` (now, or a chosen time), so
  `broadcasts:dispatch-scheduled` refreshes the segment and fans out as for email.
  `fanout_broadcast_send_recipients_batch` hands Slack sends to
  `fanout_broadcast_slack_recipients_batch`. The drip is separate:
  `broadcasts:dispatch-slack` (60s) claims with `claim_due_broadcast_slack_recipients`
  and sends one message every `SLACK_BROADCAST_INTERVAL_MS` (default 3,000ms,
  about 1,200 an hour). The email claim skips Slack sends, so a Slack backlog
  never slows email.
- **Failures.** A refused token (revoked, missing scope) pauses the send with
  the reason in `metadata.paused_reason`; resume once it's fixed. A member who
  can't be messaged (deactivated, not found) is marked failed with the Slack error
  in `last_error`. Rate limits and outages are retried, up to 5 claims per person.
- **Record.** Slack sends write no `email_send_log` rows. Each
  `broadcast_send_recipients` row is the record; its batch row's
  `provider_batch_id` is `<DM channel>:<message ts>`.
- **Routes.** `GET /api/admin/modules/broadcasts/slack/status` and
  `POST .../slack/test` (DM one person by email). Both verify the session
  (`lib/require-jwt.ts`) and require an active admin/editor. Only admins can
  test as the welcome-DM account. Migration 032 also limits the broadcast
  tables to admins (they were open to any signed-in user) and revokes the
  fan-out function from `authenticated`.

## Tables / RPCs (migrations)

- `001_broadcasts_tables.sql` — `broadcast_sends`, `broadcast_send_recipients`,
  `broadcast_suppressions`; adds `email_send_log.broadcast_send_id`.
- `002_broadcasts_fanout_claim.sql` — `fanout_broadcast_send_recipients`,
  `claim_due_broadcast_recipients`, `broadcast_send_timezone_breakdown`.

## Edge functions

- `broadcast-send` — single-recipient operator test sends only (`test_send` payload).
  The scheduled-dispatch path has moved into the Node worker
  (broadcasts:dispatch-scheduled) so there's no Edge round-trip for the cron;
  the `send_id` immediate-fanout branch is kept for backwards compatibility but
  the shared SendingPanel currently routes immediate sends through scheduled_at=now()
  via the same worker cron.
- `broadcast-unsubscribe` — RFC 8058 one-click; writes a topic suppression.

## API routes (Node-side)

- `POST /api/admin/modules/broadcasts/segments-ai-build` — the AI copilot. Uses
  the **AI module's `runChat`** (forced `emit_segment_definition` tool) → validated
  segment definition → live `segments_preview`. Runs Node-side (the AI module is
  not Deno-compatible), mounted via the `apiRoutes` hook like editor-ai-copilot.
  No API key on the module — `runChat` resolves credentials/model/cost from the
  `segments-copilot` `ai_use_cases` row (migration 003). Admin-gated via
  `admin_profiles` + the `segments_preview` is_admin() RPC.

## Admin

Top-level **Broadcasts** nav → list → builder (`Compose / Audience / Schedule /
Review & Send`). The Audience step hosts the copilot + an existing-segment
picker.

## Dependencies

`ai` (the copilot's `runChat` + `segments-copilot` use case), `bulk-emailing`
(email provider abstraction, `email_send_log`, shared quota when Tier 2 lands),
and `segments` (audience + copilot). Phase 3 of the spec extends
the segments engine with `event_filters` (migration `segments/003`) so
"attended an event in San Francisco" is expressible — requires the
`event_attended` pipeline to write `event_city`/`event_id` into
`people_events.event_data` (+ backfill).

## Tests

`tests/fanout_smoke.sql` + `tests/fanout_smoke_assert.sql` — re-runnable
fan-out / claim / timezone / suppression / event_filters smoke test against a
throwaway Postgres (see the header in fanout_smoke.sql). Verified 2026-06-18.

## Status / not-yet

Runs on the current Edge-Function drip (≈200/min), the same as newsletters
today. When the **Tier 2** worker-side `sendBatch` engine lands
(spec-newsletter-tier2-throughput.md), broadcasts fold onto the shared
table-parametric engine + shared SendGrid daily quota — the tables/RPCs here are
deliberately newsletter-shaped to make that mechanical. See
spec-broadcasts-module.md Phase 0 and the morning checklist in the build report.
