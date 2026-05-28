# Content Triage

A generic human-review gate for scraped and submitted content. Any content type can register an adapter, push items into a shared queue, and have approve/reject decisions routed to reviewers with notifications and a full audit trail. Modes range from full review to silent auto-publish.

## How It Works

The module is adapter-driven: content types are not hard-coded. A producing module registers an adapter into `content_triage_adapters`, mapping a `content_type` string to the Postgres functions the queue should call when an item is approved, rejected, suggested, or submitted.

```
content_triage_adapters
  content_type   text PK
  approve_fn     (uuid, text[], boolean, uuid)   -- called on approve
  reject_fn      (uuid, text, uuid)              -- called on reject
  suggest_fn     (uuid)                          -- optional: auto-suggest categories
  submit_fn      (uuid, boolean)                 -- optional: called on auto_publish
  display_label  text
```

A trigger validates every registration: the referenced functions must exist, be owned by the trusted `gatewaze_module_writer` role, and match the expected signature. The same role owns every triage table, so the module's `SECURITY DEFINER` RPCs bypass RLS as the table owner.

### The queue and its lifecycle

`content_triage_items` is the core queue. Each row references a content type plus the target `content_id`, and carries suggested vs. applied categories, status, priority, optional assignment, and a `lifecycle_key` that increments on reopen. A partial `EXCLUDE` constraint guarantees only one active (`pending` or `changes_requested`) item exists per `(content_type, content_id)`.

Items move through state via SECURITY DEFINER RPCs, each with optimistic concurrency (`expectedUpdatedAt`) and a permission check:

| RPC | Transition |
|---|---|
| `triage_submit` | Create a new item (or short-circuit on auto-publish) |
| `triage_approve` | `pending` -> `approved`, calls the adapter's `approve_fn` |
| `triage_reject` | `pending` -> `rejected`, calls the adapter's `reject_fn` |
| `triage_request_changes` | `pending` -> `changes_requested` |
| `triage_reopen` | `changes_requested` -> `pending`, bumps `lifecycle_key` |
| `triage_assign` | Assign/unassign to a user or team (mutually exclusive) |

### Submission modes

`triage_submit` takes a `mode` that decides how much friction an item gets:

- `auto_publish` — no triage row is created at all; the adapter's `submit_fn` is called directly (if present). Fastest path, no review.
- `auto_approve` — a row is written already in `approved` status with `auto_approved_at` set, and the `approve_fn` runs immediately.
- `review` — a `pending` row is created and reviewers are notified.

A matching route (see below) can override the requested mode via `mode_override`.

### Routing and notifications

`content_triage_routes` are declarative auto-assignment rules. Each route matches on `content_type`, `category`, `source`, a `source_ref` regex, and a `metadata` containment filter (any `NULL` field is a wildcard). The highest-priority active route wins. The winning route can assign the item to a single user or a team (`content_triage_teams` / `content_triage_team_members`), override the mode, and pick notification channels.

When a `review` item is created and a route matched, `triage_fanout_notifications` writes one `content_triage_notifications` row per recipient x channel (`in_app`, `email`, `slack`). Fan-out is idempotent via a unique constraint on `(item, lifecycle_key, recipient, channel, type)` and wakes a delivery worker via `pg_notify`. A seeded "Default catch-all" route ensures every item gets at least an in-app notification before any routing is configured; it leaves items unassigned so any admin can claim from the queue.

### Audit and idempotency

`content_triage_events` is an append-only audit log (UPDATE/DELETE revoked from everyone). `content_triage_idempotency` stores request hashes keyed by `(user, route, key)` so retried submissions replay the original response instead of double-creating.

### API and admin

`api.ts` is a thin Express layer over the RPCs: it extracts the session user, hashes the canonical request body, passes through to the RPC, and maps SQLSTATE codes to HTTP (404/409/400/403). State-changing endpoints require an `Idempotency-Key` header and an `expectedUpdatedAt` field. The admin surface provides a queue page (`/admin/triage`) and a routes editor (`/admin/triage/routes`), the latter also surfaced as a "Triage Routes" sub-tab inside the Content hub's Rules section.

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `default_triage_mode` | string | `auto_publish` | Default mode for new content producers: `auto_publish`, `auto_approve`, or `review`. |

Installing the module changes no behaviour until the mode is flipped in Settings; disabling it leaves queued items in place and resumes `auto_publish` for new content.

The API process requires `SUPABASE_URL` (or `VITE_SUPABASE_URL`) and `SUPABASE_SERVICE_ROLE_KEY`.

## Features

- `content-triage` — Core queue, submission, and review RPCs.
- `content-triage.manage` — CRUD for routes, teams, and notification preferences.
- `content-triage.override` — Act on items not assigned to you.

## Dependencies

None. The module is a foundation other content modules opt into by registering an adapter.
