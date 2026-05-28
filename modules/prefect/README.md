# `@premium-gatewaze-modules/prefect`

Self-hosted Prefect Server + Python worker that runs the **content discovery pipeline** (Phase 1) and, in Phase 3, the **AI newsletter generation** flows.

This module is unusual among Gatewaze modules: the TypeScript `index.ts` only declares configuration and migrations. The actual runtime is a **Python application** living under `workers/prefect/`, deployed as its own container alongside the rest of the stack (k8s in prod/staging, Docker Compose locally).

See the full spec: [`gatewaze-environments/specs/spec-content-discovery-pipeline.md`](../../../gatewaze-environments/specs/spec-content-discovery-pipeline.md).

---

## Layout

```
modules/prefect/
├── index.ts                      # Module manifest (configSchema, migrations)
├── package.json
├── README.md                     # (this file)
├── migrations/
│   └── 001_prefect_schema.sql    # `prefect` schema + agent_reader/agent_writer roles
├── helm/                         # Self-contained Helm subchart (chart name: prefect-worker)
│   ├── Chart.yaml
│   ├── values.yaml
│   └── templates/                # Deployments, Service, ConfigMap, Secret, SA
└── workers/prefect/              # Python runtime — see its own README
    ├── Dockerfile
    ├── pyproject.toml
    ├── README.md
    └── src/
```

**Nothing Prefect-specific lives in the core Gatewaze chart.** The module
ships a complete Helm subchart that the operator installs separately.
The only core-chart touchpoint is the generic `extraEnvFrom` hook,
which any module can use to inject env vars into core Gatewaze pods.

## What this module does

1. **Bootstraps the `prefect` schema on Supabase.** Migration 001 creates the schema, the `prefect_app` role that owns it, plus the narrow `agent_reader` and `agent_writer` roles used by the Claude Agent SDK tools (spec A.8).
2. **Declares the Prefect + agent env vars** in `configSchema`. These flow through the Helm chart's shared ConfigMap + Secret into the Prefect Server and Worker pods.
3. **Ships the Python worker runtime** under `workers/prefect/`. That directory has its own `Dockerfile`, `pyproject.toml`, and `README.md`.

The module has **no admin UI, no API routes, and no TypeScript runtime code**. The admin-facing trigger/status endpoints live in the `content-discovery` module, which calls this worker's Prefect Server over the in-cluster network.

---

## Dependency relationship

```
┌─────────────────────────┐      ┌─────────────────────────────┐
│ content-discovery       │ ───▶ │ prefect                     │
│ (lf-gatewaze-modules)   │      │ (premium-gatewaze-modules)  │
│                         │      │                             │
│ POST /trigger (admin UI)│      │ Prefect Server (k8s Deploy) │
│ POST /webhook (callback)│      │ Python Worker  (k8s Deploy) │
└───────────┬─────────────┘      └───────────┬─────────────────┘
            │                                │
            └───────► Supabase ◄─────────────┘
                      - content_pipeline tables
                      - `prefect` schema
```

`content-discovery` depends on `prefect` (declared in its manifest). Install `prefect` first; its migration creates the roles `content-discovery` assumes exist.

---

## Install order

1. **Apply migrations.** The `001_prefect_schema.sql` migration runs via the standard Gatewaze module migration mechanism. This creates:
   - `prefect` schema (owned by `prefect_app`)
   - `agent_reader` role (SELECT-only)
   - `agent_writer` role (INSERT + narrow UPDATE, column-scoped)
2. **Set the `prefect_app` password** to match the value in your subchart `values.yaml`:
   ```sql
   ALTER ROLE prefect_app WITH PASSWORD '<same value as supabase.databasePassword>';
   ```
   The migration uses a placeholder password; this step is required before Prefect Server can connect.
3. **Mint signed Supabase JWTs** for the two agent roles using the project's JWT secret:
   ```sh
   node -e "
     const { SignJWT } = require('jose');
     const secret = new TextEncoder().encode(process.env.JWT_SECRET);
     new SignJWT({ role: 'agent_reader' })
       .setProtectedHeader({ alg: 'HS256' })
       .setExpirationTime('10y')
       .setIssuer('supabase')
       .sign(secret)
       .then(console.log);
   "
   ```
   Repeat with `role: 'agent_writer'`. Store results under `supabase.agentReaderKey` / `supabase.agentWriterKey` in your prefect-worker subchart values.
4. **Install the prefect-worker Helm subchart** with your values file:
   ```sh
   helm install gatewaze-prefect-worker \
     premium-gatewaze-modules/modules/prefect/helm \
     -f my-prefect-values.yaml
   ```
   This creates:
   - `gatewaze-prefect-worker-server` Deployment + Service (ClusterIP :4200)
   - `gatewaze-prefect-worker-worker` Deployment
   - `gatewaze-prefect-worker-config` ConfigMap
   - `gatewaze-prefect-worker-secret` Secret
5. **Wire the core Gatewaze chart to consume the ConfigMap + Secret**
   so the content-discovery module (running in the gatewaze-api pod) can
   reach Prefect. Add this to your core Gatewaze `values.yaml`:
   ```yaml
   extraEnvFrom:
     - configMapRef:
         name: gatewaze-prefect-worker-config
     - secretRef:
         name: gatewaze-prefect-worker-secret
   ```
   Then `helm upgrade` the core chart. The content-discovery module's
   `PREFECT_API_URL` and `PREFECT_WEBHOOK_SECRET` are now injected into
   all core pods.
6. **Register flow deployments** (one-shot, at install time):
   ```sh
   kubectl run -it --rm prefect-register \
     --image=ghcr.io/gatewaze/prefect-worker:latest \
     --env="PREFECT_API_URL=http://gatewaze-prefect-worker-server:4200/api" \
     --command -- python -m src.main register
   ```
   Copy the printed `deployment_id` into the subchart's
   `server.discoveryDeploymentId` value and `helm upgrade` the subchart
   so the ConfigMap (and therefore the content-discovery module) picks
   up the ID.

---

## Local development

See [`workers/prefect/README.md`](workers/prefect/README.md) and [`gatewaze-environments/docker-compose.prefect.yml`](../../../gatewaze-environments/docker-compose.prefect.yml).

Quick start:

```sh
# From the gatewaze/ repo root, with your local Supabase stack running:
docker compose \
  -f docker/docker-compose.yml \
  -f ../gatewaze-environments/docker-compose.prefect.yml \
  up -d prefect-server prefect-worker

# Prefect UI: http://localhost:4200
```

---

## What's implemented

**Phase 1 — Shipped here:**
- `prefect` schema + agent role migration
- Full config schema (env vars)
- Python worker skeleton: config, CostGuard, rate_limiter, scoped Supabase clients, self-hosted Firecrawl client
- Discovery flow (`discovery_pipeline`) with Claude Agent SDK session, `rss_fetch` + `firecrawl_scrape` tools
- HMAC-signed webhook client for status callbacks
- Dockerfile, k8s manifests, Docker Compose overlay

**Phase 2 — Stubbed:**
- Triage agent (`agents/triage.py`) — raises `NotImplementedError`
- Processing agent (`agents/processing.py`) — raises `NotImplementedError`
- GitHub, YouTube, Reddit, HN custom MCP tools

**Phase 3 — Not started:**
- Newsletter generation flow
- `newsletters_generation_runs` / `newsletters_generation_blocks` tables
- Per-block AI config UI
- OpenAI client wiring for newsletter blocks

Each subsequent phase adds code inside this module; no new module is required.

---

## Architectural notes

- **The worker is Python, not Node.js.** Gatewaze modules are typically TypeScript; this one bundles a Python runtime because the Claude Agent SDK's most complete implementation is Python-native. The TS `index.ts` only exists to register the module in the Gatewaze install flow.
- **Prefect metadata lives in Supabase.** A dedicated `prefect` schema on the existing Supabase Postgres — no separate Postgres container. See spec C.1.4 for the operating constraints (direct port 5432 only, no RLS on the schema, narrow role grants).
- **Self-hosted Firecrawl.** The worker talks to an in-cluster Firecrawl service via `FIRECRAWL_API_URL`; no cloud API key.
- **Two agent roles, not one.** `agent_reader` and `agent_writer` with column-scoped UPDATE grants — a prompt-injected agent cannot rewrite arbitrary fields, DELETE rows, or touch `auth.*`, `newsletters_*`, or any user-data table.
