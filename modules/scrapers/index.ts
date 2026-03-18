import type { GatewazeModule } from '@gatewaze/shared';

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

  migrations: [
    'migrations/001_scrapers_tables.sql',
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
