# Broadcasts module

Send a **single scheduled, timezone-aware email to a segment** (or contact
list), with an **AI segment copilot** that turns a plain-language audience
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
