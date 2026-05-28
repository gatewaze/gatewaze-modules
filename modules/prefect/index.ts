import type { GatewazeModule } from '@gatewaze/shared';

/**
 * Prefect module.
 *
 * Hosts the self-hosted Prefect Server and Python worker that execute the
 * content discovery pipeline flows (discovery → triage → processing) and,
 * in Phase 3, the AI newsletter generation flows.
 *
 * The TypeScript manifest only declares schema/config — the actual worker
 * runtime lives under `workers/prefect/` (Python, deployed as its own
 * container via Helm; see `workers/prefect/README.md`).
 *
 * Design notes:
 *   - Prefect's own metadata (flow runs, task runs, deployments) lives in a
 *     dedicated `prefect` schema on the existing Supabase Postgres. The
 *     bootstrap migration for that schema ships here (001_prefect_schema.sql).
 *   - Agent DB access uses two scoped Postgres roles (`agent_reader`,
 *     `agent_writer`) created in the same migration so permission changes
 *     ship atomically with schema changes.
 *   - The worker is not a Node.js module — it exposes no admin UI or
 *     API routes. Admin-facing control-plane endpoints live in the
 *     `content-discovery` module, which calls out to the Prefect Server.
 */
const prefectWorkerModule: GatewazeModule = {
  id: 'prefect',
  group: 'integrations',
  type: 'integration',
  visibility: 'hidden',
  name: 'Prefect',
  description:
    'Self-hosted Prefect Server + Python worker for content discovery and AI newsletter generation flows.',
  version: '0.1.0',

  features: ['prefect'],

  migrations: ['migrations/001_prefect_schema.sql'],

  configSchema: {
    // ---- Prefect Server / Worker networking ----
    PREFECT_API_URL: {
      key: 'PREFECT_API_URL',
      type: 'string',
      required: true,
      description:
        'URL of the in-cluster Prefect Server API (e.g. http://gatewaze-prefect-server.gatewaze.svc.cluster.local:4200/api). Workers and control-plane callers use this.',
    },
    PREFECT_API_DATABASE_CONNECTION_URL: {
      key: 'PREFECT_API_DATABASE_CONNECTION_URL',
      type: 'secret',
      required: true,
      description:
        'SQLAlchemy URL the Prefect Server uses to reach its metadata in the `prefect` schema on the active Supabase Postgres. Format: postgresql+asyncpg://prefect_app:<pw>@<host>:5432/postgres?options=-csearch_path%3Dprefect',
    },
    PREFECT_WEBHOOK_SECRET: {
      key: 'PREFECT_WEBHOOK_SECRET',
      type: 'secret',
      required: true,
      description:
        'HMAC-SHA256 secret used by the worker to sign status webhooks back to Gatewaze (and by the content-discovery module to verify them).',
    },

    // ---- Agent API keys (Part A: discovery pipeline) ----
    ANTHROPIC_API_KEY: {
      key: 'ANTHROPIC_API_KEY',
      type: 'secret',
      required: true,
      description: 'Claude API key used by the Claude Agent SDK in all pipeline stages.',
    },
    OPENAI_API_KEY: {
      key: 'OPENAI_API_KEY',
      type: 'secret',
      required: false,
      description:
        'OpenAI API key. Not required for Phase 1 (discovery/triage/processing). Becomes required in Phase 3 when newsletter blocks route to GPT-4o.',
    },

    // ---- Firecrawl (self-hosted) ----
    FIRECRAWL_API_URL: {
      key: 'FIRECRAWL_API_URL',
      type: 'string',
      required: true,
      description:
        'URL of the self-hosted Firecrawl API (e.g. http://firecrawl-api.firecrawl.svc.cluster.local:3002). No cloud API key is used.',
    },
    FIRECRAWL_API_TOKEN: {
      key: 'FIRECRAWL_API_TOKEN',
      type: 'secret',
      required: false,
      description:
        'Optional bearer token configured on the self-hosted Firecrawl instance. Leave unset if Firecrawl is deployed without auth (in-cluster only).',
    },

    // ---- Scoped Supabase JWTs for agent DB access ----
    SUPABASE_AGENT_READER_KEY: {
      key: 'SUPABASE_AGENT_READER_KEY',
      type: 'secret',
      required: true,
      description:
        'Supabase JWT signed for the `agent_reader` Postgres role (SELECT-only on pipeline tables). Used by the supabase_query tool.',
    },
    SUPABASE_AGENT_WRITER_KEY: {
      key: 'SUPABASE_AGENT_WRITER_KEY',
      type: 'secret',
      required: true,
      description:
        'Supabase JWT signed for the `agent_writer` Postgres role (INSERT + narrow UPDATE on pipeline tables). Used by agent insert/upsert tools.',
    },

    // ---- Third-party data sources ----
    GITHUB_TOKEN: {
      key: 'GITHUB_TOKEN',
      type: 'secret',
      required: false,
      description:
        'Personal access token for the GitHub Search API. Unauthenticated calls are rate-limited to 60/hr; an authenticated token raises this to 5000/hr.',
    },
    YOUTUBE_API_KEY: {
      key: 'YOUTUBE_API_KEY',
      type: 'secret',
      required: false,
      description: 'YouTube Data API v3 key. Required only if YouTube sources are configured.',
    },

    // ---- Worker tuning ----
    DISCOVERY_COST_BUDGET_USD: {
      key: 'DISCOVERY_COST_BUDGET_USD',
      type: 'number',
      required: false,
      default: '0.50',
      description: 'CostGuard ceiling for a single discovery run (USD). See spec A.9.',
    },
    TRIAGE_COST_BUDGET_USD: {
      key: 'TRIAGE_COST_BUDGET_USD',
      type: 'number',
      required: false,
      default: '0.20',
      description: 'CostGuard ceiling for a single triage batch (USD).',
    },
    PROCESSING_COST_BUDGET_USD: {
      key: 'PROCESSING_COST_BUDGET_USD',
      type: 'number',
      required: false,
      default: '0.30',
      description: 'CostGuard ceiling per processed item (USD).',
    },
    AGENT_MAX_TURNS: {
      key: 'AGENT_MAX_TURNS',
      type: 'number',
      required: false,
      default: '25',
      description: 'Max Claude Agent SDK turns per session. Bounds runaway loops.',
    },
  },

  onInstall: async () => {
    console.log(
      '[prefect] Module installed — apply migrations, then deploy the Prefect Server + Worker via Helm (see workers/prefect/README.md)'
    );
  },

  onEnable: async () => {
    console.log('[prefect] Module enabled');
  },

  onDisable: async () => {
    console.log(
      '[prefect] Module disabled — scale Prefect Server and Worker Deployments to zero; in-flight flow runs will fail and retry on next deploy'
    );
  },
};

export default prefectWorkerModule;
