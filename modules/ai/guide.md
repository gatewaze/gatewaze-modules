# AI

Unified AI infrastructure for the platform: a provider router, per-user and per-use-case credential resolution, a cost ledger, and a reusable chat widget. Consumer features call this module's `runChat`, `aiEmbed`, and `aiGenerateImage` exports instead of instantiating OpenAI / Anthropic / Gemini SDKs directly, so credentials, pricing, and usage tracking all live in one place.

## How It Works

The module is built around a registry of **use-cases**, a **provider router**, persistent **threads/messages**, an append-only **cost ledger**, and a Goose-backed **agent runtime** (skills, recipes, and MCP servers). Most consumers only touch the first three; the agent runtime is opt-in per use-case.

### Use-cases and credential resolution

A row in `ai_use_cases` maps a string id (e.g. `editor-ai-copilot`) to defaults: `default_provider` (`auto`/`openai`/`anthropic`/`gemini`), `default_model`, an ordered `allowed_models` allow-list, an `allowed_web_tools` allow-list (`web_search` / `fetch_url`), `max_output_tokens`, and an optional `daily_cost_cap_micro_usd` soft cap. Use-cases are seeded by module manifests, then editable by operators at `/admin/ai/use-cases`.

When a call comes in, the provider router resolves a credential in priority order:

1. **User credential** — `ai_user_credentials`, one active key per `(user, provider)`.
2. **Use-case credential** — `ai_use_case_credentials`, a pinned `(use_case, provider)` key (used by cron-driven use-cases that deliberately skip personal keys).
3. **Environment variable** — the platform-level provider key.

API keys are stored encrypted via `pgsodium` (ciphertext + per-row nonce); cleartext is never returned by SELECT or any API response — only `last_4` is exposed for disambiguation. A failing key bumps `failure_count` and can flip `status` to `disabled`.

### Threads and messages

Conversations persist in `ai_threads` keyed by the natural tuple `(use_case, host_kind, host_id, thread_key)`, so any host module can mint or look up its own threads without colliding. `host_kind` / `host_id` are opaque strings supplied by the caller — there is no FK coupling back to the AI module. Each thread tracks `status` (`idle`/`running`/`ready`/`failed`/`cancelled`) plus rolled-up token + cost totals.

`ai_messages` is an append-only log of turns (`system`/`user`/`assistant`/`tool_summary`), each with a `status` driving the async lifecycle, optional `structured` JSON sidecar for structured-output turns, per-turn token/cost/latency, and a `usage_event_id` back-link into the cost ledger. RLS lets a user see only their own threads and messages; admins see all.

### Cost ledger and pricing

`ai_model_prices` is an operator-editable price book keyed by `(provider, model, effective_from)` with per-million input/output/cached token rates and per-image rates. Because each row carries `effective_from`, the helper `ai_price_at(provider, model, at)` returns the price in effect at a given time, keeping historical cost calculations accurate after pricing drift.

`ai_usage_events` is the append-only ledger — one row per LLM call, tool call, embedding batch, or image generation, tagged with `kind`, `provider`, `model`, token/byte counts, `cost_micro_usd` (computed at write time using the effective price), `status`, and back-references to the thread, message, and recipe run. `user_id` is null for cron-driven system runs.

### Async execution (job runner)

Recipe and chat execution run off the API process on the shared `jobs` queue. The API enqueues `ai:run-recipe` / `ai:run-chat`; this module registers the consumers and streams output back via Redis Streams. Run lifecycle is guarded by a state-machine trigger that validates status *transitions* (not just the value set) on `ai_recipe_runs` and `ai_messages` — e.g. `queued -> running -> complete`, with terminal states rejecting further transitions.

### Agent runtime: skills, recipes, MCP, memory

- **Agent sources** (`ai_agent_sources`) — one row per git repo. A 5-minute fan-out cron scans for due sources and enqueues a per-source sync that walks both `skills/` and `recipes/` in a single pass, populating `ai_skills` (agentskills.io-format skills) and `ai_recipes` (Goose-compatible recipe workflows). Webhooks trigger re-sync; only HTTPS git URLs are allowed.
- **Recipes** run via `runRecipe()`, with each run rooted in `ai_recipe_runs` (full per-step audit, cost rollup, snapshotted recipe hash so a run stays diagnosable even if the recipe is later deleted).
- **MCP servers** (`ai_mcp_servers`) — an operator-managed registry of Model Context Protocol servers, discriminated by `type` (`stdio` / `streamable_http` / `builtin`) with per-type required-column checks. Servers are allow-listed per use-case; a one-shot test probe records each server's advertised tool inventory.
- **Memory** (`ai_memory`) — a Gatewaze-owned key/value store that replaces Goose's local-FS memory, scoped per `thread`, `use_case`, or `user`. An hourly cron sweeps expired rows.

### Admin surface

A single tabbed dashboard lives at `/admin/ai`, with deep-linkable sub-paths (Usage, Use-cases, Models, Credentials, Agent Sources, Recipes, Jobs, MCP Servers, Memory). Modules can contribute extra tabs via the `ai-dashboard:tab` slot.

## Configuration

`configSchema` is empty — there are no per-deployment config keys declared on the module itself. Provider access is configured at runtime through credentials (user keys, use-case keys, or platform env-var provider keys) rather than module config. Worker concurrency can be tuned at deploy time via environment variables:

- `AI_RECIPE_WORKER_CONCURRENCY` (default `4`)
- `AI_CHAT_WORKER_CONCURRENCY` (default `8`)
- `AI_MCP_TEST_MAX_CONCURRENCY` (default `2`)

## Features

- `ai` — Core provider router, credential resolution, threads/messages, and the `runChat` / `aiEmbed` / `aiGenerateImage` exports.
- `ai.manage` — Operator management of use-cases, models/prices, credentials, jobs, and MCP servers.
- `ai.usage.read` — Read access to the usage dashboard, recipes, agent sources, and memory.

## Dependencies

None. The module declares no hard module dependencies — `ai_threads.host_kind` is opaque and `ai_use_cases` are operator-editable, so consumers integrate by adding their own use-case rows rather than coupling to this module's internals.
