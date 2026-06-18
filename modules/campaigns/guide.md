# Campaigns module

Send a **single scheduled, timezone-aware email to a segment** (or contact
list), with an **AI segment copilot** that turns a plain-language audience
description into a segment and attaches it. Email first; built channel-agnostic
so SMS / WhatsApp / in-app can be added later (spec-campaigns-module.md).

## How it works

Campaigns mirror the proven **newsletter send pipeline** — only the audience
*source* differs (a segment, not an edition + list) and unsubscribe is
*topic-scoped* (not per-list). It rides the same per-recipient timezone drip:

```
campaigns:dispatch-scheduled (60s BullMQ cron)
   └─ POST campaign-send { process_scheduled: true }
        ├─ fanout_campaign_send_recipients(send)   -- materialise per-recipient
        │     • source = segments_memberships (or list_subscriptions)
        │     • send_at = target_local in each recipient's timezone (global = now())
        │     • EXCLUDES campaign_suppressions (topic or 'all')  ← compliance
        │     • EXCLUDES exclude_sent_send_ids (prior sends, via sent_at)
        │     • recalc segment first (best-effort, freshness-windowed)
        └─ claim_due_campaign_recipients(200) → batched provider.send → email_send_log
```

`global` sends fan out with `send_at = now()`; `tz_local` staggers per timezone.
Pause/resume/cancel = status flips on `campaign_sends` (the claim is gated on
`status='sending'`).

## Tables / RPCs (migrations)

- `001_campaigns_tables.sql` — `campaign_sends`, `campaign_send_recipients`,
  `campaign_suppressions`; adds `email_send_log.campaign_send_id`.
- `002_campaigns_fanout_claim.sql` — `fanout_campaign_send_recipients`,
  `claim_due_campaign_recipients`, `campaign_send_timezone_breakdown`.

## Edge functions

- `campaign-send` — fan-out + drip + scheduled processor + test-send.
- `campaign-unsubscribe` — RFC 8058 one-click; writes a topic suppression.
- `segments-ai-build` — the AI copilot (forced tool use → validated segment
  definition → live `segments_preview`). Needs `ANTHROPIC_API_KEY`.

## Admin

Top-level **Campaigns** nav → list → builder (`Compose / Audience / Schedule /
Review & Send`). The Audience step hosts the copilot + an existing-segment
picker.

## Dependencies

`bulk-emailing` (email provider abstraction, `email_send_log`, shared quota when
Tier 2 lands) and `segments` (audience + copilot). Phase 3 of the spec extends
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
(spec-newsletter-tier2-throughput.md), campaigns fold onto the shared
table-parametric engine + shared SendGrid daily quota — the tables/RPCs here are
deliberately newsletter-shaped to make that mechanical. See
spec-campaigns-module.md Phase 0 and the morning checklist in the build report.
