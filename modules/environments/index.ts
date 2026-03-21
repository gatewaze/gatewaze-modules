import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

const environmentsModule: GatewazeModule = {
  id: 'environments',
  type: 'feature',
  visibility: 'public',
  name: 'Environments',
  description: 'Push and pull content between Supabase environments — sync database rows, edge functions, storage, and auth configuration across local, cloud, and self-hosted instances',
  version: '1.0.0',
  group: 'feature',
  features: [
    'environments',
    'environments.manage',
    'environments.sync',
  ],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api');
    registerRoutes(app as any, context);
  },

  migrations: [
    'migrations/001_environments_tables.sql',
  ],

  adminRoutes: [
    {
      path: 'environments',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'environments',
      guard: 'admin',
    },
    {
      path: 'environments/:environmentId',
      component: () => import('./admin/pages/detail'),
      requiredFeature: 'environments',
      guard: 'admin',
    },
    {
      path: 'environments/:environmentId/provision',
      component: () => import('./admin/pages/provision'),
      requiredFeature: 'environments.manage',
      guard: 'admin',
    },
    {
      path: 'environments/:environmentId/sync',
      component: () => import('./admin/pages/sync'),
      requiredFeature: 'environments.sync',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/admin/environments',
      label: 'Environments',
      icon: 'ServerStack',
      requiredFeature: 'environments',
      parentGroup: 'admin',
      order: 50,
    },
  ],

  configSchema: {
    encryptionKey: {
      key: 'encryptionKey',
      type: 'secret',
      required: false,
      description: 'Optional encryption key for storing environment credentials at rest',
    },
  },

  onInstall: async () => {
    console.log('[environments] Module installed');
  },

  onEnable: async () => {
    console.log('[environments] Module enabled');
  },

  onDisable: async () => {
    console.log('[environments] Module disabled');
  },
};

export default environmentsModule;
