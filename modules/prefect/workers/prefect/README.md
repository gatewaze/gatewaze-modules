# Gatewaze Prefect Worker

Python runtime for the content discovery pipeline (and, in Phase 3, AI newsletter generation). Lives inside the `prefect-worker` Gatewaze module; deployed as its own container alongside the Prefect Server.

## Layout

```
src/
├── main.py                   # Entrypoint: `worker` | `register`
├── config.py                 # Env → typed WorkerConfig
├── cost_guard.py             # Per-stage USD budget enforcement (spec A.9)
├── rate_limiter.py           # Redis-backed token buckets (spec A.5.3)
├── webhook.py                # HMAC-signed callbacks to Gatewaze
├── schemas/
│   └── discovery.py          # Pydantic output schema (spec A.8 #5)
├── clients/
│   ├── supabase.py           # Scoped agent_reader / agent_writer clients
│   └── firecrawl.py          # Self-hosted Firecrawl wrapper
├── tools/
│   └── rss_fetch.py          # Example custom MCP tool
├── agents/
│   ├── prompts.py            # System prompts + scraped-content envelope
│   ├── discovery.py          # Phase 1: discovery agent
│   ├── triage.py             # Phase 2 stub
│   └── processing.py         # Phase 2 stub
└── flows/
    └── discovery_pipeline.py # Prefect flow wiring all three stages
```

## Commands

```sh
python -m src.main worker     # start the Prefect worker (long-running)
python -m src.main register   # register flow deployments with Prefect Server
```

## Local development

1. Start your local Supabase CLI (`supabase start` in the Gatewaze repo).
2. Apply the `prefect-worker` migration to create the `prefect` schema + `agent_*` roles.
3. Bring up the Prefect stack via Docker Compose (see `gatewaze-environments/docker-compose.local-modules.yml`).
4. The worker and Prefect Server UI (`http://localhost:4200`) come up together.
5. Register deployments: `docker compose run --rm prefect-worker python -m src.main register`.

## Environment variables

See the module manifest (`../../index.ts`) — every entry in `configSchema` is consumed here.

Notable ones:

| Variable | Purpose |
|---|---|
| `PREFECT_API_URL` | Where the worker polls for flow runs |
| `PREFECT_API_DATABASE_CONNECTION_URL` | Server → Supabase `prefect` schema |
| `SUPABASE_AGENT_READER_KEY` | `agent_reader` JWT for supabase_query tool |
| `SUPABASE_AGENT_WRITER_KEY` | `agent_writer` JWT for insert/upsert tools |
| `FIRECRAWL_API_URL` | Self-hosted Firecrawl endpoint |
| `ANTHROPIC_API_KEY` | Claude Agent SDK |
| `PREFECT_WEBHOOK_SECRET` | HMAC secret for status callbacks |
| `GATEWAZE_BASE_URL` | Base URL for webhook callbacks |

## Tests

```sh
pip install -e '.[dev]'
pytest
```
