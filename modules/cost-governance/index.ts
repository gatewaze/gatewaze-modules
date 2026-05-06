import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

const costGovernanceModule: GatewazeModule = {
  id: 'cost-governance',
  type: 'core',
  visibility: 'hidden',
  name: 'Cost Governance',
  description:
    'Universal cost ledger for paid external APIs (residential proxies, Anthropic, OpenAI). Per-brand soft + hard budget caps surfaced in /admin/cost. See spec-scrapling-fetcher-service.md §15.',
  version: '1.0.0',
  features: [
    'cost-governance',
    'cost-governance.admin',
  ],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api');
    registerRoutes(app as never, context);
  },

  migrations: [
    'migrations/001_external_api_usage.sql',
  ],

  adminRoutes: [
    {
      path: 'cost',
      component: () => import('./admin/pages/CostPage'),
      requiredFeature: 'cost-governance.admin',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/admin/cost',
      label: 'Cost',
      icon: 'CurrencyDollar',
      requiredFeature: 'cost-governance.admin',
      parentGroup: 'admin',
      order: 35,
    },
  ],

  dependencies: [],
  configSchema: {},

  onInstall: async () => { console.log('[cost-governance] Module installed'); },
  onEnable:  async () => { console.log('[cost-governance] Module enabled'); },
  onDisable: async () => { console.log('[cost-governance] Module disabled'); },
};

export default costGovernanceModule;
