import type { GatewazeModule } from '@gatewaze/shared';

const accountsModule: GatewazeModule = {
  id: 'accounts',
  type: 'feature',
  visibility: 'public',
  name: 'Accounts',
  description: 'Manage accounts and organizations with role-based user assignments',
  version: '1.0.0',
  features: [
    'accounts',
    'accounts.manage',
  ],

  adminRoutes: [
    {
      path: 'accounts',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'accounts',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/admin/accounts',
      label: 'Accounts',
      icon: 'Building',
      requiredFeature: 'accounts',
      parentGroup: 'admin',
      order: 20,
    },
  ],

  migrations: [],

  configSchema: {},

  onInstall: async () => {
    console.log('[accounts] Module installed');
  },

  onEnable: async () => {
    console.log('[accounts] Module enabled');
  },

  onDisable: async () => {
    console.log('[accounts] Module disabled');
  },
};

export default accountsModule;
