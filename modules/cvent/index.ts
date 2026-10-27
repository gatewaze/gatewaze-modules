import type { GatewazeModule } from '@gatewaze/shared';

/**
 * Cvent
 *
 * Pushes event registrations to Cvent so on-site badge printing has every
 * registrant, whatever registered them (Luma webhook, Luma CSV, the portal).
 * A worker cron runs every few seconds, pushes new registrations for events
 * with live sync on, and re-pushes badge fields when a person's name, title or
 * company changes. The admin tab on each event holds the Cvent ids, the
 * live-sync toggle, a "sync now" button and a single-registrant test; the
 * event's Registrations tab shows the per-registrant state in a Cvent column.
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
  version: '2.1.2',
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
      // Badges are printed from Cvent at the door, so someone who registers on
      // Luma while queueing should be printable by the time they reach the
      // kiosk. A run with no enabled events is two queries (config, events);
      // each enabled event with nothing pending adds two more (pending,
      // changed contacts). The worker never overlaps runs; see workers/sync.ts.
      schedule: { every: 5_000 },
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
      meta: { tabId: 'cvent', label: 'Cvent', icon: 'TicketIcon' },
    },
    // Registrations tab: a status line above the table and a column in it.
    // All three render nothing until the event has a Cvent event id.
    {
      slotName: 'event-registrations:status',
      component: () => import('./admin/CventRegistrationsStatus'),
      order: 20,
      requiredFeature: 'cvent',
      meta: { label: 'Cvent badge sync' },
    },
    {
      slotName: 'event-registrations:column-header',
      component: () => import('./admin/CventRegistrationColumnHeader'),
      order: 20,
      requiredFeature: 'cvent',
      meta: { label: 'Cvent' },
    },
    {
      slotName: 'event-registrations:column-cell',
      component: () => import('./admin/CventRegistrationCell'),
      order: 20,
      requiredFeature: 'cvent',
      meta: { label: 'Cvent' },
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
      description: 'Default 4000 (the worker runs every 5 seconds). A run stops starting new work after this long; the next run continues.',
      required: false,
    },
    max_attempts: {
      key: 'max_attempts',
      type: 'number',
      label: 'Attempts per registration',
      description: 'Default 5. A registration Cvent keeps rejecting is left as failed after this many tries; "Retry failed" on the event resets it.',
      required: false,
    },
    pause_ms: {
      key: 'pause_ms',
      type: 'number',
      label: 'Pause between Cvent calls (ms)',
      description: 'Default 500, to stay under the Cvent rate limit.',
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
