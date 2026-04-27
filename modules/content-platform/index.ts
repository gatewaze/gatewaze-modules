import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

const contentPlatformModule: GatewazeModule = {
  id: 'content-platform',
  type: 'core',
  visibility: 'hidden',
  name: 'Content Platform',
  description: 'Cross-content-type publishing, categorization, source tracking, and the unified Content Inbox.',
  version: '1.0.0',
  features: [
    'content-platform',
    'content-platform.inbox',
    'content-platform.admin',
  ],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api');
    registerRoutes(app as never, context);
  },

  workers: [
    {
      name: 'content-platform:verdict-handler',
      handler: './worker/verdict-handler.js',
      concurrency: 1,
    },
  ],

  crons: [
    {
      name: 'content-platform-verdict-tick',
      queue: 'jobs',
      schedule: { every: 5_000 },
      data: { kind: 'content-platform:verdict-handler' },
    },
  ],

  migrations: [
    'migrations/001_publish_adapter_registry.sql',
    'migrations/002_category_adapter_registry.sql',
    'migrations/003_content_sources.sql',
    'migrations/004_inbox_cache.sql',
  ],

  adminRoutes: [
    {
      path: 'inbox',
      component: () => import('./admin/pages/InboxPage'),
      requiredFeature: 'content-platform.inbox',
      guard: 'none',
    },
  ],

  // Inbox nav lives in the static dashboards segment so it sits at the very top
  // of the sidebar (above all module-contributed nav items).
  adminNavItems: [],
};

export default contentPlatformModule;
