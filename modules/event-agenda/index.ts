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
