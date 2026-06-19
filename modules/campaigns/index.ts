import type { GatewazeModule } from '@gatewaze/shared';

const campaignsModule: GatewazeModule = {
  id: 'campaigns',
  group: 'communications',
  type: 'feature',
  visibility: 'public',
  name: 'Campaigns',
  description: 'Send a single scheduled, timezone-aware email to a segment, with an AI segment copilot',
  version: '0.1.0',
  features: [
    'campaigns',
    'campaigns.send',
    'campaigns.copilot',
  ],

  // ai powers the segment copilot (runChat: credentials, model, cost). segments
  // powers audience selection. bulk-emailing owns the email provider abstraction,
  // email_send_log, and (per Tier 2) the shared quota the drip will claim from.
  dependencies: ['ai', 'bulk-emailing', 'segments'],

  edgeFunctions: [
    'campaign-send',
    'campaign-unsubscribe',
  ],

  // The AI segment copilot runs Node-side (the @gatewaze-modules/ai runChat is
  // not Deno-compatible), mounted at /api/admin/modules/campaigns/segments-ai-build
  // — exactly like editor-ai-copilot. See api/register-routes.ts.
  apiRoutes: async (app, ctx) => {
    try {
      const { registerCampaignsRoutes } = await import('./api/register-routes.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await registerCampaignsRoutes(app as any, ctx as any);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[campaigns] API route registration failed:', err);
    }
  },

  workers: [
    {
      // 60s heartbeat: fan out due scheduled campaigns + drive the drip.
      // BullMQ stand-in for pg_cron (see workers/dispatch-scheduled.ts).
      name: 'campaigns:dispatch-scheduled',
      handler: './workers/dispatch-scheduled.ts',
    },
  ],

  crons: [
    {
      name: 'campaign-dispatch-scheduled',
      queue: 'jobs',
      schedule: { every: 60_000 },
      data: { kind: 'campaigns:dispatch-scheduled' },
    },
  ],

  migrations: [
    'migrations/001_campaigns_tables.sql',
    'migrations/002_campaigns_fanout_claim.sql',
    // 003 registers the 'segments-copilot' ai_use_cases row so the AI module's
    // runChat can resolve credentials/model/cost for the copilot.
    'migrations/003_segments_copilot_use_case.sql',
  ],

  adminRoutes: [
    { path: 'campaigns', component: () => import('./admin/pages/list'), requiredFeature: 'campaigns', guard: 'none' },
    { path: 'campaigns/new', component: () => import('./admin/pages/new'), requiredFeature: 'campaigns', guard: 'none' },
    { path: 'campaigns/:id', component: () => import('./admin/pages/detail'), requiredFeature: 'campaigns', guard: 'none' },
    { path: 'campaigns/:id/:tab', component: () => import('./admin/pages/detail'), requiredFeature: 'campaigns', guard: 'none' },
  ],
  adminNavItems: [
    { path: '/campaigns', label: 'Campaigns', icon: 'PaperAirplane', requiredFeature: 'campaigns', defaultSection: 'Communications', defaultLocation: 'sidebar', order: 20 },
  ],

  configSchema: {
    BULK_EMAIL_FROM_ADDRESS: {
      key: 'BULK_EMAIL_FROM_ADDRESS',
      type: 'string',
      required: false,
      description: 'Default From address for campaign sends (shared with bulk-emailing).',
    },
    BULK_EMAIL_FROM_NAME: {
      key: 'BULK_EMAIL_FROM_NAME',
      type: 'string',
      required: false,
      description: 'Default From display name for campaign sends.',
    },
    // The AI segment copilot uses the AI module (runChat), which owns credential
    // resolution + model selection via the 'segments-copilot' use case — no
    // copilot API key is configured here.
  },

  onInstall: async () => {
    console.log('[campaigns] Module installed');
  },
  onEnable: async () => {
    console.log('[campaigns] Module enabled');
  },
  onDisable: async () => {
    console.log('[campaigns] Module disabled');
  },
};

export default campaignsModule;
