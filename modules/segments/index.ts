import type { GatewazeModule } from '@gatewaze/shared';

const segmentsModule: GatewazeModule = {
  id: 'segments',
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
  ],

  adminRoutes: [
    { path: 'segments', component: () => import('./admin/pages/index'), requiredFeature: 'segments', guard: 'none' },
    { path: 'segments/create', component: () => import('./admin/pages/create'), requiredFeature: 'segments', guard: 'none' },
    { path: 'segments/:id', component: () => import('./admin/pages/[id]/index'), requiredFeature: 'segments', guard: 'none' },
    { path: 'segments/:id/edit', component: () => import('./admin/pages/[id]/edit'), requiredFeature: 'segments', guard: 'none' },
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
