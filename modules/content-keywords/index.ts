import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

const contentKeywordsModule: GatewazeModule = {
  id: 'content-keywords',
  group: 'content',
  type: 'feature',
  visibility: 'hidden',
  name: 'Content Keywords',
  description: 'Platform-wide keyword rule layer applied retroactively to all governed content. Replaces per-scraper keyword filtering with a centrally-edited rule set.',
  version: '1.0.1',
  features: [
    'content-keywords',
    'content-keywords.manage',
    'content-keywords.read',
  ],

  dependencies: ['content-triage', 'content-platform'],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api');
    registerRoutes(app as any, context);
  },

  workers: [
    {
      name: 'content-keywords:drain-queue',
      handler: './worker/drain-queue.js',
      // Advisory only: the job worker ignores per-worker concurrency and runs
      // module jobs at MODULE_WORKER_CONCURRENCY, so two drains can overlap.
      // That is harmless: evaluation is idempotent and the verdict handler
      // tolerates a duplicate event.
      concurrency: 1,
    },
    {
      name: 'content-keywords:recompute',
      handler: './worker/recompute.js',
      concurrency: 1,
    },
    {
      name: 'content-keywords:scan-stale',
      handler: './worker/scan-stale.js',
      concurrency: 1,
    },
    {
      name: 'content-keywords:break-stale-leases',
      handler: './worker/break-leases.js',
      concurrency: 1,
    },
  ],

  // Nothing else enqueues the drain on a chart deploy: the worker there only
  // runs what lands on the shared 'jobs' queue, so without this tick the
  // match queue is never drained and new items never get a keyword verdict.
  // On a database whose queue has never been drained, the first drains
  // evaluate that whole backlog for the first time, which can move published
  // items to auto_suppressed (for events that hides them from the portal; the
  // blog portal reads status, so for blog posts it only changes the inbox). recompute and scan-stale stay unscheduled on
  // purpose: they re-evaluate whole tables, so turning them on is a separate
  // decision.
  crons: [
    {
      name: 'content-keywords-drain-tick',
      queue: 'jobs',
      schedule: { every: 30_000 },
      data: { kind: 'content-keywords:drain-queue' },
    },
  ],

  migrations: [
    'migrations/001_schema.sql',
    'migrations/002_rpcs.sql',
    'migrations/003_preview_and_helpers.sql',
  ],

  // Surfaced inside the Content hub via adminSlots below.
  // Direct routes kept so legacy bookmarks work but no longer show in nav.
  adminRoutes: [
    {
      path: 'content-keywords',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'content-keywords',
      guard: 'admin',
    },
    {
      path: 'content-keywords/preview',
      component: () => import('./admin/pages/preview'),
      requiredFeature: 'content-keywords.manage',
      guard: 'admin',
    },
  ],

  adminNavItems: [],

  adminSlots: [
    {
      slotName: 'content-hub:rules',
      component: () => import('./admin/pages/index'),
      order: 10,
      requiredFeature: 'content-keywords',
      meta: { tabId: 'keywords', label: 'Keywords', description: 'Visibility rules applied retroactively across all content types' },
    },
    {
      slotName: 'content-hub:rules',
      component: () => import('./admin/pages/preview'),
      order: 20,
      requiredFeature: 'content-keywords.manage',
      meta: { tabId: 'keywords-preview', label: 'Keyword Preview', description: 'Estimate impact of rule changes before saving' },
    },
  ],

  configSchema: {
    max_active_rules_per_type: {
      key: 'max_active_rules_per_type',
      type: 'number',
      required: false,
      default: 500,
      description: 'Max number of active rules permitted per content_type before API rejects new ones.',
    },
  },

  onInstall: async () => {
    console.log('[content-keywords] Module installed — no rules; no behaviour change until adapters register and rules added.');
  },

  onEnable: async () => {
    console.log('[content-keywords] Module enabled');
  },

  onDisable: async () => {
    console.log('[content-keywords] Module disabled — workers stopped, queue rows preserved.');
  },
};

export default contentKeywordsModule;
