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
  ],

  // Cron schedule — fan-out worker scans for due skill sources every 5
  // minutes and enqueues one per-source sync per match (moved from
  // editor-ai-copilot's crons in the Phase-2 refactor).
  crons: [
    {
      name: 'ai:sync-skill-sources',
      queue: 'jobs',
      schedule: { pattern: '*/5 * * * *' },
      data: { kind: 'ai.sync-skill-sources' },
    },
  ],

  // Worker handler registry — the platform's shared `jobs` worker
  // dispatches each job to its named handler. Without these entries,
  // jobs enqueued by /admin/skill-sources/:id/sync would sit in the
  // queue forever because no consumer would be registered.
  workers: [
    {
      name: 'ai.sync-skill-sources',
      handler: 'workers/sync-skill-sources.js',
    },
    {
      name: 'ai.sync-one-skill-source',
      handler: 'workers/sync-one-skill-source.js',
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
      path: 'ai/skill-sources',
      component: () => import('./admin/components/AiDashboard'),
      requiredFeature: 'ai.usage.read',
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
