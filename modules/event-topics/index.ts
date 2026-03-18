import type { GatewazeModule } from '@gatewaze/shared';

const eventTopicsModule: GatewazeModule = {
  id: 'event-topics',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Event Topics',
  description: 'Topic taxonomy with hierarchical categories for organizing and tagging events',
  version: '1.0.0',
  features: [
    'event-topics',
    'event-topics.categories',
    'event-topics.manage',
  ],

  migrations: [
    'migrations/001_event_topics_tables.sql',
  ],

  adminRoutes: [
    { path: 'topics', component: () => import('./admin/pages/topics'), requiredFeature: 'event-topics', guard: 'admin' },
  ],
  adminNavItems: [
    { path: '/admin/topics', label: 'Topics', icon: 'Hash', requiredFeature: 'event-topics', parentGroup: 'admin', order: 23 },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[event-topics] Module installed');
  },

  onEnable: async () => {
    console.log('[event-topics] Module enabled');
  },

  onDisable: async () => {
    console.log('[event-topics] Module disabled');
  },
};

export default eventTopicsModule;
