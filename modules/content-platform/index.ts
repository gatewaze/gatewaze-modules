import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

const contentPlatformModule: GatewazeModule = {
  id: 'content-platform',
  group: 'content',
  type: 'feature',
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
      handler: './workers/verdict-handler.js',
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
    'migrations/005_fix_verdict_triage_priority.sql',
    'migrations/006_fix_inbox_cache_preview_call.sql',
    'migrations/007_inbox_cache_enrichment.sql',
    'migrations/008_content_access_registry.sql',
    'migrations/009_content_access_action_email.sql',
  ],

  adminRoutes: [
    {
      path: 'inbox',
      component: () => import('./admin/pages/InboxPage'),
      requiredFeature: 'content-platform.inbox',
      guard: 'none',
    },
    {
      // Central management view for the content_access_policies registry (member
      // gating). The inline controls in each editor write the same rows.
      path: 'content-access',
      component: () => import('./admin/pages/ContentAccessPage'),
      guard: 'admin',
    },
  ],

  // Inbox nav lives in the static dashboards segment so it sits at the very top
  // of the sidebar (above all module-contributed nav items).
  adminNavItems: [
    {
      path: '/content-access',
      label: 'Content Access',
      icon: 'ShieldCheck',
      defaultSection: 'Content',
      defaultLocation: 'sidebar',
      order: 90,
    },
  ],
};

export default contentPlatformModule;
