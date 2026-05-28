# Content Keywords

A platform-wide keyword rule layer that decides content visibility centrally and applies retroactively to every governed content type. It replaces per-scraper keyword filtering with a single, centrally-edited rule set that can be re-evaluated against all existing content on demand.

## How It Works

Like the triage module, content-keywords is adapter-driven. Each governed content type registers an adapter into `content_keyword_adapters`, declaring a `text_fn(uuid) RETURNS TABLE(field, value, source)` that yields the searchable text for an item, the backing table, the fields it exposes, and a `default_visible_when_no_rules` flag. A trigger validates the function's ownership (`gatewaze_module_writer`) and signature on registration.

### Rules

`content_keyword_rules` is the table operators edit:

```
content_keyword_rules
  name, description
  pattern         text                  -- the keyword/expression
  pattern_type    substring | word | regex
  case_sensitive  boolean
  content_types   text[]                -- which types this rule scopes to
  sources         text[]                -- NULL = all sources
  fields          text[]                -- ['any'] or specific fields
  is_active       boolean
  row_version     bigint                -- optimistic concurrency
```

Scoping is an intersection: a rule applies only where content type, source, and field conditions all hold. Triggers canonicalise the array columns (sort + dedupe), bump `updated_at` / `row_version` on every update, and — crucially — bump a per-type `content_keyword_ruleset_versions` counter whenever a visibility-affecting change occurs. That monotonic version is how the system knows which derived item states have gone stale.

### Derived visibility

Visibility is computed, not stored on the content itself. `content_keyword_item_state` holds one row per `(content_type, content_id)` with `is_visible`, the `matched_rule_ids`, and the `ruleset_version` it was evaluated against. The pure evaluator `ck_evaluate_inner` calls the adapter's `text_fn`, walks the active in-scope rules, and returns visibility plus matched rule ids. With no active rules for a type, it falls back to the adapter's `default_visible_when_no_rules`.

### Queue and workers

Evaluation is asynchronous and DB-backed. Base-table triggers (and recompute scans) enqueue work into `content_keyword_match_queue` with an op of `evaluate` or `delete`. Four BullMQ workers drain and maintain it:

| Worker | Concurrency | Job |
|---|---|---|
| `content-keywords:drain-queue` | 2 | Pull a batch via `ck_drain_queue`, evaluate or delete each item, commit or fail the row |
| `content-keywords:recompute` | 1 | Run a full recompute job over content types |
| `content-keywords:scan-stale` | 1 | Enqueue items whose `ruleset_version` is behind the current ruleset |
| `content-keywords:break-stale-leases` | 1 | Release expired recompute leases |

Failed rows retry and eventually land in `content_keyword_match_queue_dlq`. Evaluator failures are recorded in `content_keyword_eval_errors`. `content_keyword_recompute_jobs` tracks progress, status, and heartbeats; `content_keyword_recompute_leases` provides per-content-type mutual exclusion so two recomputes can't run on the same type at once.

### API

`api.ts` exposes CRUD for rules (with `If-Match` optimistic concurrency on PATCH, server-side regex compile-testing for `regex` rules), activate/deactivate, and recompute orchestration:

- `POST /api/content-keywords/recompute` — creates a job (409 if one already overlaps), scans for stale/missing items, then drains the queue inline.
- `GET /api/content-keywords/recompute[/:id]` — job history and status.
- `POST /api/content-keywords/recompute/clear-stuck` — clears jobs with stale heartbeats.
- `POST /api/content-keywords/preview-impact` — estimate how a rule change would shift visible counts before saving.
- `GET /api/content-keywords/adapters` — registered adapters merged with cached counts from `content_keyword_adapter_stats`.

### Admin

A Keywords rule editor and a Keyword Preview page are contributed into the Content hub's Rules section (`content-hub:rules` slot); the preview page lets operators estimate the impact of changes before committing them.

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `max_active_rules_per_type` | number | `500` | Maximum active rules permitted per `content_type` before the API rejects new ones. |

Installing the module is inert: with no adapters registered and no rules added there is no behaviour change. The API process requires `SUPABASE_URL` (or `VITE_SUPABASE_URL`) and `SUPABASE_SERVICE_ROLE_KEY`.

## Features

- `content-keywords` — Core rule layer, queue, and evaluator.
- `content-keywords.manage` — Create, edit, activate, recompute, and preview rules.
- `content-keywords.read` — Read-only access to rules and adapter stats.

## Dependencies

- `content-triage` — Shared content-governance infrastructure (the `gatewaze_module_writer` trusted role originates here).
- `content-platform` — The platform layer the rule layer plugs into.
