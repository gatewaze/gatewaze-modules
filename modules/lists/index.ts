import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

const listsModule: GatewazeModule = {
  id: 'lists',
  group: 'content',
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
    // 002 seeds the global 'Event Updates' list used by the events Comms tab.
    'migrations/002_event_updates_list.sql',
    // 003 adds the is_internal flag and seeds the staff-only 'internal' list.
    'migrations/003_internal_list.sql',
    // 004 cascades subscription deletion when the owning person is deleted.
    'migrations/004_subscriptions_cascade_on_person_delete.sql',
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
