import type { GatewazeModule } from '@gatewaze/shared';

const offersModule: GatewazeModule = {
  id: 'offers',
  type: 'feature',
  visibility: 'public',
  name: 'Offers',
  description: 'Create and distribute offers with acceptance tracking and conversion analytics',
  version: '1.0.0',
  features: [
    'offers',
    'offers.manage',
    'offers.tracking',
  ],

  adminRoutes: [
    {
      path: 'offers',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'offers',
      guard: 'none',
    },
    {
      path: 'offers/:eventId/accepted',
      component: () => import('./admin/pages/accepted'),
      requiredFeature: 'offers',
      guard: 'none',
    },
    {
      path: 'offers/:eventId/detail',
      component: () => import('./admin/pages/detail'),
      requiredFeature: 'offers',
      guard: 'none',
    },
  ],

  adminNavItems: [
    {
      path: '/offers',
      label: 'Offers',
      icon: 'Gift',
      requiredFeature: 'offers',
      order: 12,
    },
  ],

  edgeFunctions: [
    'integrations-track-offer',
  ],

  migrations: [
    'migrations/001_offers_tables.sql',
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[offers] Module installed');
  },

  onEnable: async () => {
    console.log('[offers] Module enabled');
  },

  onDisable: async () => {
    console.log('[offers] Module disabled');
  },
};

export default offersModule;
