# Editor AI Copilot

Adds a sidebar AI pane to the Puck-based canvas editor used by both sites and newsletter editions. Marketing and content teams can generate or revise pages from a natural-language prompt, optionally grounded in uploaded documents or public URLs. The AI is strictly constrained to the brand's template library, so designers keep control of look and feel while marketing controls content.

## How It Works

A single Puck plugin is registered into a shared plugin registry at admin-app boot (via `import.meta.glob` of `admin/index.ts`). Both the sites editor and the newsletter editor read that registry at mount time, so one registration reaches both surfaces with no direct coupling.

### Generation modes

The pane supports five modes, each producing a Puck-data result the editor merges into the canvas:

- `replace` — wipe and regenerate the page.
- `append` — extend at the end.
- `insert-after` — splice in after a chosen anchor block.
- `edit` — whole-page rewrite that preserves block ids (so the canvas-ops diff emits `update_field` ops rather than destructive delete+insert pairs).
- `edit-block` — single-block field rewrite when one block is selected.

### Defence in depth

The core promise is that the AI can only emit blocks the designer has approved into the brand's theme, with field values that validate against each block's schema. Four layers enforce this:

1. A constrained tool-use schema at the provider layer (the LLM is only offered the library's blocks).
2. Per-block ajv re-validation at the application layer (`lib/output-validator.ts`), dropping or sanitising anything that deviates.
3. Per-string-field sanitisation at the content layer (richtext is run through a strict DOMPurify allowlist).
4. The existing canvas-ops authority at save time.

### Host adapters

Targets are polymorphic on `host_kind` (`site` or `newsletter`). `registerHostAdapter` wires up a sites adapter and a newsletters adapter at route-mount time; the generate handler looks up the right one per request to load the target, its template library, and to write results back.

### The generate flow

`POST /api/admin/modules/editor-ai-copilot/generate` resolves the target via the host adapter, builds the prompt and tool schema, calls the LLM, validates output, persists an audit row, and returns Puck data. A minimal middleware decodes the caller's JWT to a `userId`; authorization is then re-checked server-side via `assertCanAdminHost` (a service-role super-admin lookup), so a forged token cannot administer a host the caller has no rights to.

### Source documents (grounding)

`POST .../documents` ingests file uploads (`.pdf`, `.docx`, `.md`, `.txt`) and public URLs (including public Google Docs) through SSRF-guarded fetching and per-format parsers. Only the parsed plain text is stored in `canvas_ai_documents` (the raw file is never persisted), capped per document and given a 1-hour TTL. A combined token budget is enforced across all referenced docs at generate time. A 15-minute cron (`editor-ai-copilot:sweep-expired-documents`) deletes expired rows as a backstop.

### Web tools

Optional, opt-in per deployment: Anthropic-hosted `web_search` and a client-side `fetch_url` tool (SSRF-guarded, with a turn cache and content truncation). Each invocation is logged on the audit row and counted against daily quota and cost budgets via the atomic `canvas_ai_bump_tool_usage` RPC. A global kill switch strips both tools from every request.

### AI Skills

Generations can be extended with git-driven "skills" (prompt fragments) selected per host. This module keeps a per-host AI Skills picker (contributed into the newsletter and site detail settings slots) and a minimal skills-reading shim; the skill-source management subsystem itself was moved to the `ai` module in a later refactor.

### Data model

| Table | Purpose |
|---|---|
| `canvas_ai_audit_log` | One row per generation attempt (success or failure); also the source for the per-user-per-day quota. Includes token counts, web-search / fetched-url logs, and active-skill auditing. |
| `canvas_ai_documents` | Short-TTL parsed source documents (Phase F). |
| `canvas_ai_daily_tool_usage` | Daily quota + cost rollup per `(day, tool)` for web tools. |

Reads are gated to admins via RLS; writes go through the service-role client.

## Configuration

The module is hard-disabled unless at least one provider key is present. All numeric/runtime settings are read from `SITES_CANVAS_AI_*` env vars (with the config-schema fields below mirroring the most common ones).

Required / common environment:

| Env var | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` | — | At least one required; otherwise the endpoint returns 503 and the pane stays hidden. |
| `SITES_CANVAS_AI_ENABLED` | `true` if a key is set | Feature kill switch. |
| `SITES_CANVAS_AI_PROVIDER` | `auto` | `anthropic`, `openai`, or `auto`. |
| `SITES_CANVAS_AI_PER_USER_PER_MIN` | `10` | Per-user rate limit (in-memory). |
| `SITES_CANVAS_AI_PER_SITE_PER_MIN` | `30` | Per-site rate limit (in-memory). |
| `SITES_CANVAS_AI_PER_USER_PER_DAY` | `100` | Per-user daily limit (counted from the audit log; survives restarts). |
| `SITES_CANVAS_AI_MAX_DOCS_PER_REQUEST` | `5` | Max source documents per generation. |

Many more knobs exist for prompt/output budgets, document TTL and size caps, SSRF fetch limits, web-tool quotas and cost budgets, and AI-skill sync — see `lib/canvas-ai-config.ts`. The Anthropic model is restricted to an allow-list of models that support the `web_search_20250305` server-side tool. Other settings (provider preference, per-user/per-site/per-day limits, max docs) are also surfaced in the module's `configSchema`.

## Features

- `editor-ai-copilot` — The Puck sidebar AI pane, generation endpoint, document ingestion, web tools, and AI Skills picker.

## Dependencies

- `sites` — One of the two editor consumers; also the source of the shared Puck plugin registry.
- `newsletters` — The other editor consumer.
- `templates` — The schema authority for the AI's structured output (the block library the AI is constrained to).
