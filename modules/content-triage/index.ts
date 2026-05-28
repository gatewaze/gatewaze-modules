import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

const contentTriageModule: GatewazeModule = {
  id: 'content-triage',
  group: 'content',
  type: 'feature',
  visibility: 'hidden',
  name: 'Content Triage',
  description: 'Human-review gate for scraped and submitted content. Generic queue, routing, notifications, audit trail.',
  version: '1.0.0',
  features: [
    'content-triage',
    'content-triage.manage',     // CRUD routes/teams/prefs
    'content-triage.override',   // act on items not assigned to you
  ],

  dependencies: [],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api');
    registerRoutes(app as any, context);
  },

  migrations: [
    'migrations/001_content_triage_schema.sql',
    'migrations/002_content_triage_rpcs.sql',
    'migrations/003_seed_default_route.sql',
    'migrations/004_triage_permission_service_role_bypass.sql',
  ],

  // Surfaced inside the Content hub via adminSlots below.
  // Direct routes are kept so legacy bookmarks work but no longer show in nav.
  adminRoutes: [
    {
      path: 'triage',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'content-triage',
      guard: 'admin',
    },
    {
      path: 'triage/routes',
      component: () => import('./admin/pages/routes'),
      requiredFeature: 'content-triage.manage',
      guard: 'admin',
    },
  ],

  adminNavItems: [],

  adminSlots: [
    // Legacy 'content-hub:inbox' slot removed — superseded by the unified
    // /admin/inbox page in content-platform. The Triage admin route below is
    // kept for legacy bookmarks but no longer surfaced in nav or hub.
    {
      slotName: 'content-hub:rules',
      component: () => import('./admin/pages/routes'),
      order: 30,
      requiredFeature: 'content-triage.manage',
      meta: { tabId: 'triage-routes', label: 'Triage Routes', description: 'Routing rules for triage assignments' },
    },
  ],

  configSchema: {
    default_triage_mode: {
      key: 'default_triage_mode',
      type: 'string',
      required: false,
      default: 'auto_publish',
      description: 'Default triage mode for new content producers: auto_publish | auto_approve | review',
    },
  },

  onInstall: async () => {
    console.log('[content-triage] Module installed — default mode is auto_publish (no behaviour change until flipped in Settings)');
  },

  onEnable: async () => {
    console.log('[content-triage] Module enabled');
  },

  onDisable: async () => {
    console.log('[content-triage] Module disabled — queued items remain; auto_publish resumes for new content');
  },
};

export default contentTriageModule;
