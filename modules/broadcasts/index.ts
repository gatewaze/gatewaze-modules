import type { GatewazeModule } from '@gatewaze/shared';

const broadcastsModule: GatewazeModule = {
  id: 'broadcasts',
  group: 'communications',
  type: 'feature',
  visibility: 'public',
  name: 'Broadcasts',
  description: 'Send a single scheduled, timezone-aware email to a segment, with an AI segment copilot',
  version: '0.1.0',
  features: [
    'broadcasts',
    'broadcasts.send',
    'broadcasts.copilot',
  ],

  // ai powers the segment copilot (runChat: credentials, model, cost). segments
  // powers audience selection. bulk-emailing owns the email provider abstraction,
  // email_send_log, and (per Tier 2) the shared quota the drip will claim from.
  dependencies: ['ai', 'bulk-emailing', 'segments'],

  edgeFunctions: [
    'broadcast-send',
    'broadcast-unsubscribe',
  ],

  // The AI segment copilot runs Node-side (the @gatewaze-modules/ai runChat is
  // not Deno-compatible), mounted at /api/admin/modules/broadcasts/segments-ai-build
  // — exactly like editor-ai-copilot. See api/register-routes.ts.
  apiRoutes: async (app, ctx) => {
    try {
      const { registerBroadcastsRoutes } = await import('./api/register-routes.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await registerBroadcastsRoutes(app as any, ctx as any);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[broadcasts] API route registration failed:', err);
    }
  },

  workers: [
    {
      // 60s heartbeat: fan out due scheduled broadcasts + drive the drip.
      // BullMQ stand-in for pg_cron (see workers/dispatch-scheduled.ts).
      name: 'broadcasts:dispatch-scheduled',
      handler: './workers/dispatch-scheduled.ts',
    },
  ],

  crons: [
    {
      name: 'broadcast-dispatch-scheduled',
      queue: 'jobs',
      schedule: { every: 60_000 },
      data: { kind: 'broadcasts:dispatch-scheduled' },
    },
  ],

  migrations: [
    'migrations/001_broadcasts_tables.sql',
    'migrations/002_broadcasts_fanout_claim.sql',
    // 003 registers the 'segments-copilot' ai_use_cases row so the AI module's
    // runChat can resolve credentials/model/cost for the copilot.
    'migrations/003_segments_copilot_use_case.sql',
    // 004 adds broadcast_send_batches + watchdog index for the Central Sending
    // Service worker drip (Phase 2 — always active now).
    'migrations/004_send_engine_batches.sql',
    // 005 ties broadcasts to a category list for unsubscribe (list-tied model).
    'migrations/005_broadcasts_category_list.sql',
    // 006 splits broadcasts into a parent (definition) + send instances, so a
    // broadcast can have many sends (uniform parent→sends model, shared UI).
    'migrations/006_broadcasts_parent.sql',
    // 007 adds broadcast_recipient_preview_count for the shared SendingPanel's
    // deliverable-count indicator (mirrors fan-out audience resolution).
    'migrations/007_broadcast_recipient_preview_count.sql',
    // 008 optionally links a broadcast to an event (CFP / event promotion):
    // {{event_*}} variables baked into content at send-creation.
    'migrations/008_broadcast_event_link.sql',
    // 009 captures inbound replies to broadcast emails (broadcast_replies +
    // forward_replies_to), mirroring the newsletter replies model.
    'migrations/009_broadcast_replies.sql',
    // 010 intersects the broadcast audience with the unsubscribe list's subscribers
    // (count + fan-out), so only list subscribers within the audience are emailed.
    'migrations/010_broadcast_list_intersection.sql',
    // 011 records outbound admin replies (the "reply to a reply" composer).
    'migrations/011_broadcast_reply_messages.sql',
    // 012 adds star/archive triage status to broadcast replies.
    'migrations/012_broadcast_reply_status.sql',
  ],

  adminRoutes: [
    { path: 'broadcasts', component: () => import('./admin/pages/list'), requiredFeature: 'broadcasts', guard: 'none' },
    { path: 'broadcasts/new', component: () => import('./admin/pages/new'), requiredFeature: 'broadcasts', guard: 'none' },
    { path: 'broadcasts/:id', component: () => import('./admin/pages/detail'), requiredFeature: 'broadcasts', guard: 'none' },
    { path: 'broadcasts/:id/:tab', component: () => import('./admin/pages/detail'), requiredFeature: 'broadcasts', guard: 'none' },
  ],
  adminNavItems: [
    { path: '/broadcasts', label: 'Broadcasts', icon: 'Mail', requiredFeature: 'broadcasts', defaultSection: 'Communications', defaultLocation: 'sidebar', order: 20 },
  ],

  configSchema: {
    BULK_EMAIL_FROM_ADDRESS: {
      key: 'BULK_EMAIL_FROM_ADDRESS',
      type: 'string',
      required: false,
      description: 'Default From address for broadcast sends (shared with bulk-emailing).',
    },
    BULK_EMAIL_FROM_NAME: {
      key: 'BULK_EMAIL_FROM_NAME',
      type: 'string',
      required: false,
      description: 'Default From display name for broadcast sends.',
    },
    // The AI segment copilot uses the AI module (runChat), which owns credential
    // resolution + model selection via the 'segments-copilot' use case — no
    // copilot API key is configured here.
  },

  onInstall: async () => {
    console.log('[broadcasts] Module installed');
  },
  onEnable: async () => {
    console.log('[broadcasts] Module enabled');
  },
  onDisable: async () => {
    console.log('[broadcasts] Module disabled');
  },
};

export default broadcastsModule;
