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

  // Segments power audience selection + the copilot; bulk-emailing owns the
  // email provider abstraction, email_send_log, and (per Tier 2) the shared
  // quota the campaign drip will claim from.
  dependencies: ['bulk-emailing', 'segments'],

  edgeFunctions: [
    'campaign-send',
    'campaign-unsubscribe',
    // The AI segment copilot. Builds a segment definition from natural language;
    // used by the campaign Audience step. Lives here (rather than segments) so
    // all new campaign work is cohesive; it only reads/validates the segments
    // schema + calls segments_preview.
    'segments-ai-build',
  ],

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
    ANTHROPIC_API_KEY: {
      key: 'ANTHROPIC_API_KEY',
      type: 'secret',
      required: false,
      description: 'Claude API key for the AI segment copilot (segments-ai-build). Read via Deno.env.get() at edge-function runtime.',
    },
    SEGMENTS_COPILOT_MODEL: {
      key: 'SEGMENTS_COPILOT_MODEL',
      type: 'string',
      required: false,
      description: 'Override the copilot model id (default claude-sonnet-4-20250514, the house pin).',
    },
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
