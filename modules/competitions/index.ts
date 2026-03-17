import type { GatewazeModule } from '@gatewaze/shared';

const competitionsModule: GatewazeModule = {
  id: 'competitions',
  type: 'feature',
  visibility: 'public',
  name: 'Competitions',
  description: 'Run competitions with entry submissions, judging workflows, and winner selection',
  version: '1.0.0',
  features: [
    'competitions',
    'competitions.entries',
    'competitions.judging',
  ],

  edgeFunctions: [
    'events-competition-entry',
  ],

  migrations: [
    'migrations/001_competitions_tables.sql',
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[competitions] Module installed');
  },

  onEnable: async () => {
    console.log('[competitions] Module enabled');
  },

  onDisable: async () => {
    console.log('[competitions] Module disabled');
  },
};

export default competitionsModule;
