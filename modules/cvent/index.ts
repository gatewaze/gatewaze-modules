import type { GatewazeModule } from '@gatewaze/shared';

/**
 * Cvent
 *
 * Pushes event registrations to Cvent so on-site badge printing has every
 * registrant, whatever registered them (Luma webhook, Luma CSV, the portal).
 * A worker cron reads the ledger table every minute, pushes new registrations
 * for events with live sync on, and re-pushes badge fields when a person's
 * name, title or company changes. The admin tab on each event holds the Cvent
 * ids, the live-sync toggle, a "sync now" button and a single-registrant test.
 *
 * Version 2 replaced the edge function + pg_net trigger design: those ran
 * against the pre-rename schema (customers / member_profiles), needed a
 * service-role key stored in the database, and exposed an unauthenticated
 * endpoint. Nothing in the database now holds credentials or calls out.
 */
const cventModule: GatewazeModule = {
  id: 'cvent',
  name: 'Cvent',
  description: 'Sync event registrations to Cvent for on-site badge printing',
  version: '2.0.0',
  type: 'integration',
  visibility: 'public',
  group: 'events',
  features: ['cvent', 'cvent.sync'],

  dependencies: ['events'],

  migrations: [
    // Cvent columns on events (the events module also declares them; both are idempotent).
    'migrations/001_cvent_event_columns.sql',
    // Sync ledger + the pending/changed/status helpers; drops the legacy trigger function.
    'migrations/003_cvent_registration_sync.sql',
  ],

  workers: [
    { name: 'cvent:sync', handler: './workers/sync.ts' },
  ],

  crons: [
    {
      name: 'cvent-sync',
      queue: 'jobs',
      // Badges are printed from Cvent at the door, so a registration should be
      // there within a minute. A run with no enabled events is one query.
      schedule: { every: 60_000 },
      data: { kind: 'cvent:sync' },
    },
  ],

  apiRoutes: async (app: unknown, ctx?: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    await registerRoutes(app as never, ctx as never);
  },

  adminSlots: [
    {
      slotName: 'event-detail:tab',
      component: () => import('./admin/CventTab'),
      order: 160,
      requiredFeature: 'cvent',
      meta: { tabId: 'cvent', label: 'Cvent', icon: 'IdentificationIcon' },
    },
  ],

  configSchema: {
    CVENT_CLIENT_ID: {
      key: 'CVENT_CLIENT_ID',
      type: 'string',
      label: 'Cvent OAuth client id',
      required: true,
      description: 'Client id of the Cvent REST API OAuth client (Cvent → Admin → Integrations → REST API).',
    },
    CVENT_CLIENT_SECRET: {
      key: 'CVENT_CLIENT_SECRET',
      type: 'secret',
      encrypted: true,
      label: 'Cvent OAuth client secret',
      required: true,
      description: 'Client secret for the same OAuth client. Sealed at rest.',
    },
    batch_size: {
      key: 'batch_size',
      type: 'number',
      label: 'Registrations per event per run',
      description: 'Default 100. Each run pushes at most this many new registrations per event.',
      required: false,
    },
    budget_ms: {
      key: 'budget_ms',
      type: 'number',
      label: 'Time budget per run (ms)',
      description: 'Default 50000. A run stops starting new work after this long; the next run continues.',
      required: false,
    },
  },

  onInstall: async () => {
    console.log('[cvent] Module installed');
  },
  onEnable: async () => {
    console.log('[cvent] Module enabled');
  },
  onDisable: async () => {
    console.log('[cvent] Module disabled');
  },
};

export default cventModule;
