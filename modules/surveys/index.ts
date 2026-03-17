import type { GatewazeModule } from '@gatewaze/shared';

const surveysModule: GatewazeModule = {
  id: 'surveys',
  type: 'feature',
  visibility: 'public',
  name: 'Surveys',
  description: 'Create and distribute surveys, collect responses, and analyze results',
  version: '1.0.0',
  features: [
    'surveys',
    'surveys.create',
    'surveys.responses',
  ],

  migrations: [
    'migrations/001_surveys_tables.sql',
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[surveys] Module installed');
  },

  onEnable: async () => {
    console.log('[surveys] Module enabled');
  },

  onDisable: async () => {
    console.log('[surveys] Module disabled');
  },
};

export default surveysModule;
