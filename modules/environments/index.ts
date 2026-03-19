import type { GatewazeModule } from '@gatewaze/shared';
import { registerRoutes } from './api';

const environmentsModule: GatewazeModule = {
  id: 'environments',
  type: 'integration',
  visibility: 'public',
  name: 'Environments',
  description: 'Push and pull content between Supabase environments — sync database rows, edge functions, storage, and auth configuration across local, cloud, and self-hosted instances',
  version: '1.0.0',
  group: 'platform',
  features: [
    'environments',
    'environments.manage',
    'environments.sync',
  ],

  apiRoutes: (app: unknown) => registerRoutes(app as any),

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
      path: 'environments/:environmentId/sync',
      component: () => import('./admin/pages/sync'),
      requiredFeature: 'environments.sync',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/environments',
      label: 'Environments',
      icon: 'Server',
      requiredFeature: 'environments',
      parentGroup: 'platform',
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
