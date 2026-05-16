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
  ],

  apiRoutes: async (app: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRoutes(app as any);
  },

  adminRoutes: [
    {
      path: 'ai/usage',
      component: () => import('./admin/components/AiUsageDashboard'),
      requiredFeature: 'ai.usage.read',
      guard: 'none',
    },
    {
      path: 'ai/use-cases',
      component: () => import('./admin/components/AiUseCasesAdmin'),
      requiredFeature: 'ai.manage',
      guard: 'none',
    },
    {
      path: 'ai/credentials',
      component: () => import('./admin/components/AiCredentialsAdmin'),
      requiredFeature: 'ai.manage',
      guard: 'none',
    },
  ],

  adminNavItems: [
    {
      path: '/ai/usage',
      label: 'AI usage',
      // CurrencyDollar visualises the cost-tracking angle without
      // implying a specific provider.
      icon: 'CurrencyDollar',
      requiredFeature: 'ai.usage.read',
      order: 88,
    },
    {
      path: '/ai/use-cases',
      label: 'AI use-cases',
      icon: 'Cog',
      requiredFeature: 'ai.manage',
      order: 89,
    },
    {
      path: '/ai/credentials',
      label: 'AI credentials',
      icon: 'Key',
      requiredFeature: 'ai.manage',
      order: 90,
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
