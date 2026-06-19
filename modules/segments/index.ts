import type { GatewazeModule } from '@gatewaze/shared';

const segmentsModule: GatewazeModule = {
  id: 'segments',
  group: 'people',
  type: 'feature',
  visibility: 'public',
  name: 'Segments',
  description: 'Create and manage audience segments for targeted communications and analytics',
  version: '1.0.0',
  features: [
    'segments',
    'segments.create',
    'segments.manage',
  ],

  migrations: [
    'migrations/001_segments_tables.sql',
    'migrations/002_segments_functions.sql',
    // 003 wires event_filters (predicates on people_events.event_data) into
    // segments_event_to_sql so "attended an event in San Francisco" is
    // expressible. See spec-campaigns-module.md Phase 3.
    'migrations/003_event_filters.sql',
    // 004 adds a 'subscription' condition (membership in a newsletter/list via
    // list_subscriptions); source=newsletter resolves the list live from the
    // newsletter. First example of cross-module audience targeting.
    'migrations/004_subscription_condition.sql',
  ],

  adminRoutes: [
    { path: 'segments', component: () => import('./admin/pages/index'), requiredFeature: 'segments', guard: 'none' },
    { path: 'segments/create', component: () => import('./admin/pages/create'), requiredFeature: 'segments', guard: 'none' },
    { path: 'segments/:id', component: () => import('./admin/pages/[id]/index'), requiredFeature: 'segments', guard: 'none' },
    { path: 'segments/:id/edit', component: () => import('./admin/pages/[id]/index'), requiredFeature: 'segments', guard: 'none' },
  ],

  adminNavItems: [
    { path: '/segments', label: 'Segments', icon: 'Filter', requiredFeature: 'segments', order: 14 },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[segments] Module installed');
  },

  onEnable: async () => {
    console.log('[segments] Module enabled');
  },

  onDisable: async () => {
    console.log('[segments] Module disabled');
  },
};

export default segmentsModule;
