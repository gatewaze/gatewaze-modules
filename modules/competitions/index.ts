import type { GatewazeModule } from '@gatewaze/shared/modules';

const competitionsModule: GatewazeModule = {
  id: 'competitions',
  type: 'feature',
  group: 'events',
  name: 'Competitions',
  description: 'Competition entry management for events',
  version: '1.0.0',
  features: [
    'competitions',
    'competitions.entry',
  ],

  edgeFunctions: [
    'events-competition-entry',
  ],

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
