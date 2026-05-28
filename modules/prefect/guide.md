# Prefect

Self-hosted Prefect Server plus a Python worker that runs the content discovery pipeline flows and, in a later phase, AI newsletter generation. The module is hidden and unusual: its TypeScript manifest only declares schema, config, and migrations — the runtime is a Python application under `workers/prefect/`, deployed as its own container via Helm.

## How It Works

The module has no admin UI, API routes, or TypeScript runtime code. It contributes three things to the platform:

1. **The `prefect` schema migration** (`001_prefect_schema.sql`). Prefect's own metadata (flow runs, task runs, deployments) lives in a dedicated `prefect` schema on the existing platform Postgres rather than a separate database. The migration also creates two narrowly-scoped Postgres roles used by the agent's database tools:
   - `agent_reader` — SELECT-only on pipeline tables.
   - `agent_writer` — INSERT plus column-scoped UPDATE on pipeline tables.

   Because the roles ship in the same migration as the schema, permission changes deploy atomically with schema changes. A prompt-injected agent cannot DELETE rows, rewrite arbitrary columns, or reach `auth.*` and user-data tables.
2. **The config schema** for the Prefect Server, worker, and agent (see below). These values flow through the Helm chart's shared ConfigMap and Secret into the server and worker pods.
3. **The Python worker runtime** under `workers/prefect/` (its own `Dockerfile`, `pyproject.toml`, and `README.md`), plus a self-contained Helm sub-chart under `helm/` for the server and worker Deployments.

### Pipeline

The worker runs the discovery pipeline as Prefect flows. `flows/discovery_pipeline.py` discovers content candidates (via a Claude Agent SDK session with RSS-fetch and self-hosted Firecrawl tools), validates them against a Pydantic schema, and persists accepted items to `content_submissions` through the `agent_writer` role. Triage and processing run as their own scheduled flows. Each stage is bounded by a `CostGuard` USD ceiling and a turn cap, signs status callbacks back to the platform with an HMAC secret, and double-stamps the run row in the database as the source of truth.

The admin-facing trigger and status endpoints are not in this module — they live in the content-discovery module, which calls this worker's Prefect Server over the in-cluster network and verifies its signed webhooks. Install `prefect` first so the roles content-discovery assumes exist are present.

## Configuration

All values are declared in `index.ts` and consumed by the Python worker; secrets flow through the Helm Secret.

Networking and webhooks:

| Variable | Required | Purpose |
|---|---|---|
| `PREFECT_API_URL` | Yes | In-cluster Prefect Server API URL used by workers and control-plane callers. |
| `PREFECT_API_DATABASE_CONNECTION_URL` | Yes (secret) | SQLAlchemy URL the server uses to reach its metadata in the `prefect` schema on the platform Postgres. |
| `PREFECT_WEBHOOK_SECRET` | Yes (secret) | HMAC-SHA256 secret used to sign status webhooks back to the platform. |

Agent API keys:

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes (secret) | Claude Agent SDK key used in all pipeline stages. |
| `OPENAI_API_KEY` | No (secret) | Not required for discovery/triage/processing; needed for the later newsletter-generation phase. |

Firecrawl (self-hosted):

| Variable | Required | Purpose |
|---|---|---|
| `FIRECRAWL_API_URL` | Yes | In-cluster Firecrawl API URL (no cloud key). |
| `FIRECRAWL_API_TOKEN` | No (secret) | Optional bearer token if the Firecrawl instance is deployed with auth. |

Scoped database access:

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_AGENT_READER_KEY` | Yes (secret) | JWT signed for the `agent_reader` role; used by the read tool. |
| `SUPABASE_AGENT_WRITER_KEY` | Yes (secret) | JWT signed for the `agent_writer` role; used by insert/upsert tools. |

Third-party data sources:

| Variable | Required | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | No (secret) | Raises the GitHub Search API rate limit from 60/hr to 5000/hr. |
| `YOUTUBE_API_KEY` | No (secret) | Required only if YouTube sources are configured. |

Worker tuning (numeric, with defaults):

| Variable | Default | Purpose |
|---|---|---|
| `DISCOVERY_COST_BUDGET_USD` | `0.50` | CostGuard ceiling for a single discovery run. |
| `TRIAGE_COST_BUDGET_USD` | `0.20` | CostGuard ceiling for a single triage batch. |
| `PROCESSING_COST_BUDGET_USD` | `0.30` | CostGuard ceiling per processed item. |
| `AGENT_MAX_TURNS` | `25` | Max Claude Agent SDK turns per session; bounds runaway loops. |

Install order, JWT minting, role-password setup, and Helm deployment are documented in `README.md` and `workers/prefect/README.md`. Disabling the module scales the server and worker Deployments to zero; in-flight flow runs fail and retry on the next deploy.

## Features

- `prefect` — Self-hosted Prefect Server and Python worker for content discovery and AI newsletter generation flows.

## Dependencies

None declared. This module is a prerequisite for the content-discovery module rather than a consumer of others — install it first so its `prefect` schema and `agent_reader` / `agent_writer` roles exist.
