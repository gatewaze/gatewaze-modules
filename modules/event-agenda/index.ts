import type { GatewazeModule } from '@gatewaze/shared';

const eventAgendaModule: GatewazeModule = {
  id: 'event-agenda',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Event Agenda',
  description: 'Schedule and manage event agenda sessions, time slots, and tracks',
  version: '1.2.0',
  features: [
    'event-agenda',
    'event-agenda.manage',
  ],

  migrations: [
    'migrations/001_event_agenda_tables.sql',
    'migrations/002_schedule_import.sql',
  ],

  adminSlots: [
    {
      slotName: 'event-detail:tab',
      component: () => import('./admin/EventAgendaTab'),
      order: 10,
      requiredFeature: 'event-agenda',
      meta: { tabId: 'agenda', label: 'Agenda', icon: 'ListBulletIcon' },
    },
  ],

  dependencies: ['events', 'event-speakers'],

  apiRoutes: async (app: unknown, ctx?: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- express/ctx shapes are host-provided
    await registerRoutes(app as any, ctx as any);
  },

  workers: [
    {
      // File stem must equal the job-name suffix: the prod worker derives the
      // job name from the handler filename as `${moduleId}:${stem}`.
      name: 'event-agenda:import-schedule',
      handler: './workers/import-schedule.ts',
      concurrency: 1,
    },
    {
      name: 'event-agenda:sweep-schedules',
      handler: './workers/sweep-schedules.ts',
      concurrency: 1,
    },
  ],

  crons: [
    {
      // 03:30 UTC. The sweep is a no-op unless auto_import_schedules is on,
      // so registering the cron costs nothing for brands that have not opted in.
      name: 'event-agenda:sweep-schedules',
      queue: 'jobs',
      schedule: { pattern: '30 3 * * *' },
      data: { kind: 'event-agenda:sweep-schedules' },
    },
  ],

  configSchema: {
    auto_import_schedules: {
      key: 'auto_import_schedules',
      type: 'boolean',
      required: false,
      default: 'false',
      label: 'Refresh conference programmes nightly',
      description:
        'Re-read each conference\'s published schedule every night and update its agenda. Imports are skipped when the source has not changed, and operator edits are never overwritten.',
    },
  },

  onInstall: async () => {
    console.log('[event-agenda] Module installed');
  },

  onEnable: async () => {
    console.log('[event-agenda] Module enabled');
  },

  onDisable: async () => {
    console.log('[event-agenda] Module disabled');
  },
};

export default eventAgendaModule;
