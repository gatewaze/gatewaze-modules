# Tasks

Asana-style task management with tree, kanban, and calendar views, cross-module linking, recurrence, dependencies, comments with @-mentions, and outbound webhooks. Tasks live on boards and can be attached to platform entities (events, speakers, content items, lists, pipelines, forms) so work travels with the thing it relates to.

## How It Works

The module is built around **boards**. Each board (`task_boards`) defines its own status columns, custom fields, members, and behaviour switches:

- `dependency_mode` (`hard` / `soft`) — whether open blockers prevent a task moving to a non-done status.
- `parent_completion` (`auto` / `manual`) — whether completing all children auto-completes the parent.
- `kanban_includes` (`top_only` / `all`) — whether the kanban view shows only root tasks or the whole tree.
- `realtime_enabled`, `time_zone`, `color`, `icon`.

**Tasks** (`tasks`) are self-referential via `parent_task_id`, giving an arbitrarily nested tree. Ordering within a parent uses a fractional `sort_index` string (see `lib/sort-index.ts`) so reorders and reparents are single-row updates with no renumbering. Soft deletes use `deleted_at`. A task carries an assignee, priority, estimate, start/due dates, custom field values, and optional recurrence.

Supporting tables:

| Table | Purpose |
|---|---|
| `board_members` | Per-board role (`owner` / `editor` / `viewer`) — drives RLS and permission checks (`lib/permissions.ts`). |
| `board_statuses` | Ordered status columns; one default, one or more done-states. |
| `board_custom_fields` + `task_field_values` | Per-board typed fields (text, number, select, multi_select, date, person, url, boolean). |
| `task_dependencies` | `blocker_id` → `blocked_id` edges. Postgres triggers reject cycles and (in hard mode) block status moves. |
| `task_links` | Polymorphic link from a task to a platform entity (`events`, `speakers`, `content_items`, `lists`, `pipelines`, `forms`). The target is FK-validated at the application layer. |
| `task_comments` | Markdown comments; `@[Name](user:uuid)` mentions are parsed into a `mentions[]` array. |
| `task_activity` | Append-only activity feed (created, reordered, dependency_added, link_added, recurrence_spawned, etc.). |
| `task_notifications` | Per-recipient in-app/email notifications. |
| `task_user_prefs` | Per-user notification toggles, email cadence, due-soon lead time. |
| `task_recurrence_state` | Dedupe state for the recurrence spawner. |
| `board_webhooks` + `task_webhook_outbox` | Outbound webhook config and an at-least-once delivery outbox. |

### API

Admin routes are mounted at `/api/admin/tasks/*` (`api.ts`). They use a per-request Supabase client that propagates the caller's JWT so Postgres RLS enforces access; the JWT `sub` is resolved to the `admin_profiles.id` that every task table references. Responses use a `{ data, meta: { request_id } }` envelope, and Postgres trigger errors are mapped to typed API codes (`DEPENDENCY_BLOCKED`, `CYCLE_DETECTED`, `PARENT_CYCLE_DETECTED`). The list endpoint serves `flat`, `tree`, `kanban`, and `calendar` shapes from the same query.

### Admin UI

- `/admin/tasks` — boards list.
- `/admin/tasks/inbox` — notification inbox.
- `/admin/tasks/boards/:id` — board detail with tree / kanban / calendar / gantt views; board settings open as a side-drawer overlay.

The module also contributes a **Tasks** tab into the detail pages of events, speakers, content items, and lists via admin slots, rendering the tasks linked to that entity.

### Workers

| Worker | Concurrency | What it does |
|---|---|---|
| `tasks:recurrence-spawner` | 1 | Finds completed recurrence templates, computes the next occurrence from the RRULE, deep-clones the subtree with shifted dates, and resets the template. Deduped via `task_recurrence_state`. |
| `tasks:due-soon-notifier` | 1 | Hourly. Writes `due_soon` notifications for tasks entering each assignee's lead window. Idempotent via `tasks.due_soon_notified_at`. |
| `tasks:email-digest-sender` | 1 | Daily/weekly. Groups pending notifications per user and sends a digest via the platform email pipeline. |
| `tasks:webhook-dispatcher` | 4 | Drains `task_webhook_outbox`, builds per-kind payloads (Slack / Discord / generic), POSTs with timeout, exponential backoff, and up to 5 attempts before abandoning. |

## Configuration

| Setting | Type | Required | Description |
|---|---|---|---|
| `TASKS_WEBHOOK_ENCRYPTION_KEY` | secret | No | Application-layer AES key used to encrypt `board_webhooks.url` and `secret` at write time. When unset, the module logs a degraded-mode warning and stores the values in plaintext — set it before using webhooks in production. |

## Features

- `tasks` — Core boards, tasks, views, comments, links, and notifications.
- `tasks.boards.manage` — Manage existing boards (statuses, custom fields, members, settings).
- `tasks.boards.create` — Create new boards.
- `tasks.webhooks` — Per-board outbound webhooks (Slack / Discord / generic).

## Dependencies

None declared. The module links to other entities (`events`, `speakers`, `content_items`, `lists`, `pipelines`, `forms`) opportunistically — links are validated against whichever target tables exist at runtime rather than via a hard module dependency.
