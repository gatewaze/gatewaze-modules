import type { GatewazeModule } from '@gatewaze/shared';

const schedulerModule: GatewazeModule = {
  id: 'scheduler',
  type: 'feature',
  visibility: 'hidden',
  name: 'Scheduler',
  description: 'Job queue and scraper scheduler management dashboard',
  version: '1.0.0',
  features: [
    'scheduler',
    'scheduler.manage',
  ],

  adminRoutes: [
    {
      path: 'scheduler',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'scheduler',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/admin/scheduler',
      label: 'Scheduler',
      icon: 'Clock',
      requiredFeature: 'scheduler',
      parentGroup: 'admin',
      order: 35,
    },
  ],

  migrations: [],

  configSchema: {},

  onInstall: async () => {
    console.log('[scheduler] Module installed');
  },

  onEnable: async () => {
    console.log('[scheduler] Module enabled');
  },

  onDisable: async () => {
    console.log('[scheduler] Module disabled');
  },
};

export default schedulerModule;
