import type { GatewazeModule } from '@gatewaze/shared';

const structuredResourcesModule: GatewazeModule = {
  id: 'resources',
  group: 'content',
  type: 'feature',
  visibility: 'premium',
  name: 'Structured Resources',
  description: 'Create and manage hierarchical resource guides with configurable section templates and access control',
  version: '1.0.0',
  features: [
    'resources',
    'resources.collections',
    'resources.import',
  ],

  dependencies: ['content-platform'],

  migrations: [
    'migrations/001_structured_resources.sql',
    'migrations/002_triage_adapter.sql',
    'migrations/003_keyword_adapter.sql',
    'migrations/004_register_with_platform.sql',
  ],

  adminRoutes: [
    {
      path: 'resources/collections',
      component: () => import('./admin/pages/collections/index'),
      requiredFeature: 'resources',
      guard: 'none',
    },
    {
      path: 'resources/collections/:id',
      component: () => import('./admin/pages/collection/index'),
      requiredFeature: 'resources',
      guard: 'none',
    },
    {
      path: 'resources/collections/:id/:tab',
      component: () => import('./admin/pages/collection/index'),
      requiredFeature: 'resources',
      guard: 'none',
    },
    {
      path: 'resources/import',
      component: () => import('./admin/pages/import/index'),
      requiredFeature: 'resources.import',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/resources/collections',
      label: 'Resources',
      icon: 'BookOpen',
      requiredFeature: 'resources',
      order: 18,
    },
  ],

  portalNav: {
    label: 'Resources',
    path: '/resources',
    icon: 'book-open',
    order: 25,
  },

  portalRoutes: [
    { path: '/resources', component: () => import('./portal/pages/index') },
    { path: '/resources/:collectionSlug', component: () => import('./portal/pages/[collectionSlug]/index') },
    { path: '/resources/:collectionSlug/:itemSlug', component: () => import('./portal/pages/[collectionSlug]/[itemSlug]') },
  ],

  configSchema: {
    default_access: {
      type: 'select',
      label: 'Default content access',
      default: 'authenticated',
      options: ['public', 'authenticated'],
      description: 'Default access level for new collections. Individual collections can override this.',
    },
    show_teaser: {
      type: 'boolean',
      label: 'Show teaser to unauthenticated users',
      default: true,
      description: 'When a collection requires auth, show titles and descriptions with a sign-in prompt',
    },
  },

  onInstall: async () => {
    console.log('[resources] Module installed');
  },

  onEnable: async () => {
    console.log('[resources] Module enabled');
  },

  onDisable: async () => {
    console.log('[resources] Module disabled');
  },
};

export default structuredResourcesModule;
