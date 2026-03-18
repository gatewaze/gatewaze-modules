import type { GatewazeModule } from '@gatewaze/shared';

const eventSpeakersModule: GatewazeModule = {
  id: 'event-speakers',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Event Speakers',
  description: 'Manage speaker profiles, bios, session assignments, and speaker communications',
  version: '1.0.0',
  features: [
    'event-speakers',
    'event-speakers.manage',
  ],

  migrations: [
    'migrations/001_event_speakers_tables.sql',
  ],

  dependencies: ['event-sponsors'],

  configSchema: {},

  onInstall: async () => {
    console.log('[event-speakers] Module installed');
  },

  onEnable: async () => {
    console.log('[event-speakers] Module enabled');
  },

  onDisable: async () => {
    console.log('[event-speakers] Module disabled');
  },
};

export default eventSpeakersModule;
