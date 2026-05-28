# editor-ai-copilot

AI copilot for the Puck-based canvas editor across sites and
newsletter editions.

Per spec
[`gatewaze-environments/specs/spec-canvas-ai-copilot.md`](../../../gatewaze-environments/specs/spec-canvas-ai-copilot.md) v5.

## What it does

Adds a sidebar pane to the Puck editor (same drawer as Outline /
Components / Fields) that lets marketing / content teams generate
or revise pages by prompting an LLM. The AI is constrained to the
target's template library — it can ONLY emit blocks that the
designer has approved into the brand's theme repo, and only with
field values that validate against each block's schema. Three
layers of defence in depth enforce this.

Five generation modes:

- `replace` — wipe and regenerate
- `append` — extend at the end
- `insert-after` — splice in after a chosen anchor
- `edit` — whole-page rewrite preserving block ids (so the
  canvas-ops diff emits `update_field` ops, not destructive
  delete+insert pairs)
- `edit-block` — single-block field rewrite when a block is
  selected in the canvas

Phase F adds **source-document ingestion** — file uploads
(`.pdf`, `.docx`, `.md`, `.txt`) and public URLs (incl. public
Google Docs) provide grounding context for the generation.

## Cost ceilings

Per generation, worst case:

- prompt-only: ~$0.021 (Anthropic Claude Haiku 4.5)
- `edit` mode on a 15-block page: ~$0.05
- with 50 k tokens of source-doc context: ~$0.085

Per-user default budget: 100 generations / 24 h ≈ $2.10 / user /
day. Configurable via `SITES_CANVAS_AI_*` env vars.

## Module shape

| Layer | Where |
|---|---|
| Migrations | `migrations/001_canvas_ai_audit_log.sql`, `migrations/002_canvas_ai_documents.sql` |
| Config (env-read) | `lib/canvas-ai-config.ts` |
| Provider clients | `lib/providers/{anthropic,openai,router}-client.ts` |
| Prompt construction | `lib/prompt-builder.ts` |
| Output validation | `lib/output-validator.ts` |
| Host adapters (polymorphic on `host_kind`) | `lib/host-adapter-{registry,sites,newsletters}.ts` |
| Document parsers | `api/parsers/{pdf,docx,markdown,txt,html}-parser.ts` |
| URL fetcher (SSRF-safe) | `api/url-fetcher.ts` |
| Endpoints | `api/{generate,documents,register-routes}.ts` |
| TTL sweep worker | `workers/sweep-expired-documents.ts` |
| Admin Puck plugin | `admin/components/aiPlugin.tsx` |
| Admin sidebar pane | `admin/components/AiSidebarPane.tsx` |

The module follows Gatewaze's standard manifest contract — it
declares its migrations, API contribution, and admin
contribution in `index.ts`. Brands enable/disable it via the
existing modules admin page; the LLM dependencies, audit table,
and sidebar UI all disappear cleanly when the module is
disabled.

## Required env

- `ANTHROPIC_API_KEY` (preferred) and/or `OPENAI_API_KEY`. At
  least one must be present; if neither is set, the endpoint
  returns 503 and the sidebar pane stays hidden.
- `SITES_CANVAS_AI_ENABLED` (optional, default `true` when a
  provider key is present).
- `SITES_CANVAS_AI_PROVIDER` (optional, `anthropic` | `openai` |
  `auto`).
- `SITES_CANVAS_AI_PER_USER_PER_MIN` (optional, default 10).
- `SITES_CANVAS_AI_PER_SITE_PER_MIN` (optional, default 30).
- `SITES_CANVAS_AI_PER_USER_PER_DAY` (optional, default 100).

## Plugin registry

Sites' `PuckCanvasEditor` and newsletter's `NewsletterPuckCanvas`
both read Puck plugins from a small shared registry exported by
`@gatewaze-modules/sites/canvas-puck-plugin-registry`. This
module's `admin/index.ts` registers `aiPlugin` into that
registry at module-load time. Both editors pick it up without
any direct dependency on this module.

## Tests

```
pnpm --filter @gatewaze-modules/editor-ai-copilot test
```

Unit tests for prompt-builder, output-validator,
puck-data-merger, url-fetcher (SSRF rejection cases), and each
parser. Integration tests for the endpoints exist as supertest
suites that mock the LLM providers.
