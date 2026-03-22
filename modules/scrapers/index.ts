import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

const scrapersModule: GatewazeModule = {
  id: 'scrapers',
  type: 'feature',
  visibility: 'hidden',
  name: 'Scrapers',
  description: 'Configure and run web scraping jobs for event discovery and content aggregation',
  version: '1.0.0',
  features: [
    'scrapers',
    'scrapers.manage',
    'scrapers.schedules',
  ],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api');
    registerRoutes(app as any, context);
  },

  migrations: [
    'migrations/001_scrapers_tables.sql',
    'migrations/002_seed_mlops_scrapers.sql',
  ],

  adminRoutes: [
    {
      path: 'scrapers',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'scrapers',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/admin/scrapers',
      label: 'Scrapers',
      icon: 'Globe',
      requiredFeature: 'scrapers',
      parentGroup: 'admin',
      order: 29,
    },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[scrapers] Module installed');
  },

  onEnable: async () => {
    console.log('[scrapers] Module enabled');
  },

  onDisable: async () => {
    console.log('[scrapers] Module disabled');
  },
};

export default scrapersModule;
