# Content Platform

Cross-content-type publishing, categorization, source tracking, and the unified Content Inbox. The module provides a shared spine that any content type (events, articles, and others) can register against to get a guarded publish-state machine, automatic member/community categorization, provenance tracking, and a single admin triage queue — without each content type reimplementing it.

## How It Works

The module is adapter-driven: rather than owning content tables itself, it exposes registries that other modules register their tables into, then enforces shared behavior across all of them. A dedicated `gatewaze_module_writer` role owns the registry tables and the guarded setter functions, which run `SECURITY DEFINER` and are `EXECUTE`-granted to `service_role` only.

### Publish-state registry and guarded setter

`content_publish_adapters` maps each `content_type` to its `table_name`, the `publish_state` column to gate, a display label, and an optional inbox-preview function. A module registers via `register_content_type(...)`, which validates that the target table has a `uuid` id column and a text-typed publish-state column, then grants the writer role `UPDATE` on just that column.

Every state change must go through `content_publish_state_set(content_type, content_id, to, actor, reason)`. It locks the row, validates the transition against a closed state machine, applies the update, and writes a row to `content_publish_state_audit`. The allowed transitions:

```
draft           -> pending_review | published
pending_review  -> auto_suppressed | published | rejected
published       -> auto_suppressed | unpublished | pending_review
auto_suppressed -> pending_review | published
rejected        -> pending_review
unpublished     -> published
```

Same-state writes are no-ops. An invalid transition raises `INVALID_STATE_TRANSITION`.

### Verdict handler (keyword moderation bridge)

When a keyword-moderation verdict changes whether content is visible, a row lands in `content_publish_state_event_queue`. A 5-second cron fires the `content-platform:verdict-handler` worker, which drains the queue (any content type) and calls `handle_keyword_verdict_change(content_type, content_id)`. That function reads the latest visibility verdict, locks the content row, and atomically: flips `published`/`pending_review` content to `auto_suppressed` when no longer visible (or `auto_suppressed` back to `pending_review` when visible again) via the guarded setter, and submits a triage row when review is needed. The queue supports retry with backoff and a dead-letter path; unregistering a content type dead-letters its pending queue rows.

### Category adapter

`content_category_adapters` maps a content type to its category column and the `member` / `community` values. A trigger on the keyword item-state table (`cm_category_sync_universal`) propagates membership-rule matches into the registered content table — flipping the row's category to `members` or `community`. It only overwrites categories that are NULL or in the adapter's `auto_managed_values`, preserving any manual admin override.

### Source tracking

`content_sources` records how each piece of content arrived (`admin_ui`, `api`, `mcp`, `scraper`, `ai_discovery`, `user_submission`, `import`, `unknown`) keyed by `(content_type, content_id)`. Callers upsert via the idempotent `record_content_source(...)`. The migration backfills `events.source_type` into this table where present.

### Unified inbox

The admin Inbox is the cross-content-type triage surface. `refresh_inbox_cache(content_type, content_id)` calls the content type's registered inbox-preview function to refresh cached `title` / `subtitle` / `thumbnail_url` on open triage items, so the inbox can render rows without joining into each underlying content table. The API exposes:

- `GET /api/admin/inbox/list` — the triage queue.
- `POST /api/admin/inbox/bulk` — bulk actions on triage items.
- `GET /api/admin/inbox/explain/:triage_item_id` — explain why an item is in the queue.

The Inbox page (`/inbox`, gated by `content-platform.inbox`) renders the list with a per-row detail drawer. Its nav entry lives in the static dashboards segment so it sits at the top of the sidebar, which is why the module declares no `adminNavItems`.

## Configuration

This module has no per-deployment config (no `configSchema` is declared). The worker resolves Supabase connection details from the standard platform environment (`SUPABASE_URL` / `VITE_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`).

## Features

- `content-platform` — Core adapter registries, the guarded publish-state machine, category sync, and source tracking.
- `content-platform.inbox` — The unified Content Inbox triage page and its API routes.
- `content-platform.admin` — Admin management surfaces for the content platform.

## Dependencies

None declared. The module is a foundation other content modules register into via `register_content_type` / `register_category_adapter`; it discovers companion tables (keyword item-state, triage adapters, events) at runtime with soft guards rather than hard module dependencies.
