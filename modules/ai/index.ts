/**
 * @gatewaze-modules/ai — unified AI infrastructure module.
 *
 * Owns: provider router (OpenAI / Anthropic / Gemini), per-user + per-
 * use-case credential resolution, cost ledger, reusable assistant-ui-
 * based chat widget. Consumers (editor-ai-copilot, daily-briefing,
 * portal/chat, portal/ai-search, attendee-matching, content-pipeline)
 * call into this module's `runChat`, `aiEmbed`, `aiGenerateImage`
 * exports rather than instantiating provider SDKs themselves.
 *
 * Spec: gatewaze-environments/specs/spec-ai-module.md.
 */

import type { GatewazeModule } from '@gatewaze/shared';

const aiModule: GatewazeModule = {
  id: 'ai',
  group: 'platform',
  type: 'feature',
  visibility: 'public',
  name: 'AI',
  description:
    'Unified AI infrastructure: provider router, per-user credentials, cost ledger, chat widget. Replaces ad-hoc Anthropic/OpenAI/Gemini integrations across the platform.',
  version: '1.0.0',

  features: ['ai', 'ai.manage', 'ai.usage.read'],

  // No hard module deps: ai_threads.host_kind is opaque; ai_use_cases
  // are operator-editable. Consumers add their own use-case rows via
  // module manifest declarations (planned post-Phase-A).
  dependencies: [],

  migrations: [
    'migrations/001_ai_use_cases.sql',
    'migrations/002_ai_threads_messages.sql',
    'migrations/003_ai_credentials.sql',
    'migrations/004_ai_model_prices.sql',
    'migrations/005_ai_usage_events.sql',
    'migrations/006_ai_seed_prices.sql',
    'migrations/007_ai_seed_use_cases.sql',
    'migrations/008_ai_use_cases_skill_ref.sql',
    'migrations/009_ai_skills.sql',
    'migrations/010_ai_seed_web_search.sql',
    'migrations/011_ai_cache_creation_tracking.sql',
    'migrations/012_ai_gatewaze_search.sql',
    'migrations/013_ai_skills_agentskills_io.sql',
    'migrations/014_ai_recipes.sql',
    'migrations/015_ai_recipes_version_prompt.sql',
    // spec-ai-job-runner — worker dispatch + Redis Streams SSE + Jobs tab.
    'migrations/016_ai_use_cases_allow_retry.sql',
    'migrations/017_ai_recipe_runs_queued_status.sql',
    'migrations/018_ai_messages_queued_status.sql',
    'migrations/019_ai_recipe_run_steps.sql',
    'migrations/020_ai_recipe_runs_snapshot.sql',
    'migrations/021_ai_run_state_machine.sql',
    'migrations/022_ai_run_state_machine_relax.sql',
    'migrations/023_ai_run_provenance.sql',
    // Unify skill + recipe sources behind a single ai_agent_sources
    // table. One repo = one row. CASCADE drops ai_skills + ai_recipes
    // and rebuilds them with FKs to ai_agent_sources.
    'migrations/024_ai_agent_sources_unified.sql',
    'migrations/025_ai_use_cases_recipe_binding.sql',
    // Per-kind sync-commit columns so skill + recipe passes don't
    // share a fast-path key (the shared column caused recipe sync to
    // short-circuit after the skill pass updated it).
    'migrations/026_ai_agent_sources_per_kind_sync.sql',
    // spec-ai-mcp-extensions.md — operator-managed MCP server registry,
    // per-use-case allowlist, Goose runtime overrides, use-case
    // templates, Gatewaze-owned memory backing store.
    'migrations/027_ai_mcp_servers.sql',
    'migrations/028_ai_use_case_mcp_allowlist.sql',
    'migrations/029_ai_use_cases_goose_runtime_overrides.sql',
    'migrations/030_ai_use_case_templates.sql',
    'migrations/031_ai_use_case_templates_seed.sql',
    'migrations/032_ai_recipe_runs_mcp_columns.sql',
    'migrations/033_ai_messages_mcp_columns.sql',
    'migrations/034_ai_usage_events_mcp_kind.sql',
    'migrations/035_ai_memory.sql',
  ],

  // Cron schedule — fan-out worker scans for due agent sources every
  // 5 minutes and enqueues one per-source sync per match. The
  // per-source job (ai.sync-one-agent-source) handles BOTH skills/
  // and recipes/ in a single pass against ai_agent_sources
  // (migration 024 unification).
  crons: [
    {
      name: 'ai:sync-agent-sources',
      queue: 'jobs',
      schedule: { pattern: '*/5 * * * *' },
      data: { kind: 'ai.sync-agent-sources' },
    },
    // spec-ai-job-runner §4.1 — orphan-stream sweep. Runs every hour;
    // walks ai:run:* and ai:thread:* keys; sets EXPIRE on any that
    // lack one. Defence-in-depth for SIGKILL'd workers.
    {
      name: 'ai:cleanup-orphan-streams',
      queue: 'jobs',
      schedule: { pattern: '0 * * * *' },
      data: { kind: 'ai.cleanup-orphan-streams' },
    },
    // spec-ai-mcp-extensions.md §Memory backing store §Retention.
    // Hourly sweep of ai_memory rows where expires_at < now().
    {
      name: 'ai:cleanup-expired-memory',
      queue: 'jobs',
      schedule: { pattern: '0 * * * *' },
      data: { kind: 'ai.cleanup-expired-memory' },
    },
  ],

  // Worker handler registry — the platform's shared `jobs` worker
  // dispatches each job to its named handler. Without these entries,
  // jobs enqueued by /admin/skill-sources/:id/sync would sit in the
  // queue forever because no consumer would be registered.
  workers: [
    // Unified sync — replaces the four legacy sync-* workers
    // (sync-skill-sources, sync-one-skill-source, sync-recipe-sources,
    // sync-one-recipe-source) after migration 024 collapsed the two
    // source tables into ai_agent_sources.
    {
      name: 'ai.sync-agent-sources',
      handler: 'workers/sync-agent-sources.js',
    },
    {
      name: 'ai.sync-one-agent-source',
      handler: 'workers/sync-one-agent-source.js',
    },
    // spec-ai-job-runner — moves recipe + chat execution off the API
    // process. The API enqueues onto the shared `jobs` queue under
    // these names; this module registers the consumers.
    //
    // Concurrency tuned per spec §4.1: recipe DFS workloads block on
    // provider latency, chat streams add more parallelism. Override
    // at deploy time via env if needed.
    {
      name: 'ai:run-recipe',
      handler: 'workers/run-recipe-handler.js',
      concurrency: Number(process.env.AI_RECIPE_WORKER_CONCURRENCY ?? 4),
    },
    {
      name: 'ai:run-chat',
      handler: 'workers/run-chat-handler.js',
      concurrency: Number(process.env.AI_CHAT_WORKER_CONCURRENCY ?? 8),
    },
    // Orphan-stream sweep — runs every hour via the platform's cron
    // → worker bridge. Defence-in-depth on top of the worker's own
    // EXPIRE-after-XADD: catches streams left unexpired by SIGKILL
    // between first XADD and the immediate EXPIRE call.
    {
      name: 'ai:cleanup-orphan-streams',
      handler: 'workers/cleanup-orphan-streams.js',
      concurrency: 1,
    },
    // spec-ai-mcp-extensions.md §Memory backing store §Retention.
    // Hourly sweep of ai_memory rows where expires_at < now().
    {
      name: 'ai:cleanup-expired-memory',
      handler: 'workers/cleanup-expired-memory.js',
      concurrency: 1,
    },
  ],

  apiRoutes: async (app: unknown, ctx: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // ctx carries enqueueJob (plus brand/logger). registerRoutes needs
    // it so the skill-sources handler can dispatch sync jobs after a
    // source is created or the operator clicks Sync.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRoutes(app as any, ctx as any);
  },

  // Single tabbed dashboard at /admin/ai (Usage / Use-cases / Models /
  // Credentials + any module-contributed tabs via the
  // 'ai-dashboard:tab' slot — see editor-ai-copilot for Skill Sources).
  //
  // Each sub-path is registered separately and all mount the SAME
  // dashboard component; the shell parses location.pathname to pick the
  // active tab. This mirrors EventsShell's pattern and lets deep links
  // (/admin/ai/usage etc.) resolve correctly through react-router.
  adminRoutes: [
    {
      path: 'ai',
      component: () => import('./admin/components/AiDashboard'),
      requiredFeature: 'ai.usage.read',
      guard: 'admin',
    },
    {
      path: 'ai/usage',
      component: () => import('./admin/components/AiDashboard'),
      requiredFeature: 'ai.usage.read',
      guard: 'admin',
    },
    {
      path: 'ai/use-cases',
      component: () => import('./admin/components/AiDashboard'),
      requiredFeature: 'ai.manage',
      guard: 'admin',
    },
    {
      path: 'ai/models',
      component: () => import('./admin/components/AiDashboard'),
      requiredFeature: 'ai.manage',
      guard: 'admin',
    },
    {
      path: 'ai/credentials',
      component: () => import('./admin/components/AiDashboard'),
      requiredFeature: 'ai.manage',
      guard: 'admin',
    },
    {
      path: 'ai/agent-sources',
      component: () => import('./admin/components/AiDashboard'),
      requiredFeature: 'ai.usage.read',
      guard: 'admin',
    },
    {
      path: 'ai/recipes',
      component: () => import('./admin/components/AiDashboard'),
      requiredFeature: 'ai.usage.read',
      guard: 'admin',
    },
    {
      path: 'ai/jobs',
      component: () => import('./admin/components/AiDashboard'),
      requiredFeature: 'ai.manage',
      guard: 'admin',
    },
    {
      path: 'ai/mcp-servers',
      component: () => import('./admin/components/AiDashboard'),
      requiredFeature: 'ai.manage',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/admin/ai',
      label: 'AI',
      // Sparkles reads as "AI / generative" without provider lock-in.
      icon: 'Sparkles',
      requiredFeature: 'ai.usage.read',
      parentGroup: 'admin',
      order: 30,
    },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[ai] Module installed (v1.0.0)');
  },
  onEnable: async () => {
    console.log('[ai] Module enabled — provider router + cost ledger online');
  },
  onDisable: async () => {
    console.log('[ai] Module disabled — consumers will fail with no_credentials');
  },
};

export default aiModule;
