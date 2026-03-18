import type { GatewazeModule } from '@gatewaze/shared';

const newslettersModule: GatewazeModule = {
  id: 'newsletters',
  type: 'feature',
  visibility: 'public',
  name: 'Newsletters',
  description: 'Create, edit, and distribute newsletters with edition management and subscriber tracking',
  version: '1.0.0',
  features: [
    'newsletters',
    'newsletters.editor',
    'newsletters.editions',
    'newsletters.subscribers',
  ],

  migrations: [
    'migrations/001_newsletters_tables.sql',
  ],

  adminRoutes: [
    { path: 'newsletters', component: () => import('./admin/pages/index'), requiredFeature: 'newsletters', guard: 'none' },
    { path: 'newsletters/editor/:id', component: () => import('./admin/pages/editions/[id]'), requiredFeature: 'newsletters', guard: 'none' },
    { path: 'newsletters/:tab', component: () => import('./admin/pages/index'), requiredFeature: 'newsletters', guard: 'none' },
  ],
  adminNavItems: [
    { path: '/newsletters', label: 'Newsletters', icon: 'Newspaper', requiredFeature: 'newsletters', order: 16 },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[newsletters] Module installed');
  },

  onEnable: async () => {
    console.log('[newsletters] Module enabled');
  },

  onDisable: async () => {
    console.log('[newsletters] Module disabled');
  },
};

export default newslettersModule;
