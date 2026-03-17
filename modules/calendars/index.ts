import type { GatewazeModule } from '@gatewaze/shared';

const calendarsModule: GatewazeModule = {
  id: 'calendars',
  type: 'feature',
  visibility: 'public',
  name: 'Calendars',
  description: 'Manage event calendars with discovery, CSV import, and scheduling APIs',
  version: '1.0.0',
  features: [
    'calendars',
    'calendars.discover',
    'calendars.import',
  ],

  edgeFunctions: [
    'calendars-api',
    'calendars-discover',
    'calendars-process-csv',
  ],

  migrations: [
    'migrations/001_calendars_tables.sql',
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[calendars] Module installed');
  },

  onEnable: async () => {
    console.log('[calendars] Module enabled');
  },

  onDisable: async () => {
    console.log('[calendars] Module disabled');
  },
};

export default calendarsModule;
