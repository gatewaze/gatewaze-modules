import type { GatewazeModule } from '@gatewaze/shared';

const eventAgendaModule: GatewazeModule = {
  id: 'event-agenda',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Event Agenda',
  description: 'Schedule and manage event agenda sessions, time slots, and tracks',
  version: '1.0.0',
  features: [
    'event-agenda',
    'event-agenda.manage',
  ],

  migrations: [
    'migrations/001_event_agenda_tables.sql',
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

  dependencies: ['event-speakers'],

  configSchema: {},

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
