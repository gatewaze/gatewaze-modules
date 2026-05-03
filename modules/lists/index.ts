import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

const listsModule: GatewazeModule = {
  id: 'lists',
  type: 'feature',
  visibility: 'public',
  name: 'Lists',
  description: 'Manage subscription lists with subscribe/unsubscribe flows, webhook notifications, and external system sync.',
  version: '1.0.0',
  features: [
    'lists',
    'lists.manage',
    'lists.webhooks',
    'lists.import',
  ],

  // Depends on templates for the wrapper FK introduced in 004_lists_git_provenance.
  dependencies: ['templates'],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api');
    registerRoutes(app as any, context);
  },

  migrations: [
    'migrations/001_lists_tables.sql',
    'migrations/002_migrate_from_email_subscriptions.sql',
    'migrations/003_external_api_key.sql',
    'migrations/004_lists_git_provenance.sql',
  ],

  adminRoutes: [
    {
      path: 'lists',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'lists',
      guard: 'admin',
    },
  ],

  adminSlots: [
    {
      slotName: 'person-detail:subscriptions',
      component: () => import('./admin/components/PersonSubscriptions'),
      order: 10,
      requiredFeature: 'lists',
    },
  ],

  adminNavItems: [
    {
      path: '/admin/lists',
      label: 'Lists',
      icon: 'QueueList',
      requiredFeature: 'lists',
      parentGroup: 'admin',
      order: 25,
    },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[lists] Module installed');
  },
  onEnable: async () => {
    console.log('[lists] Module enabled');
  },
  onDisable: async () => {
    console.log('[lists] Module disabled');
  },
};

export default listsModule;
