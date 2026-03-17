import type { GatewazeModule } from '@gatewaze/shared';

const newslettersModule: GatewazeModule = {
  id: 'newsletters',
  type: 'feature',
  visibility: 'public',
  name: 'Newsletters',
  description: 'Create, edit, and distribute newsletters with edition management and subscriber tracking',
  version: '1.0.0',
  features: [
    'newsletters',
    'newsletters.editor',
    'newsletters.editions',
    'newsletters.subscribers',
  ],

  migrations: [
    'migrations/001_newsletters_tables.sql',
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[newsletters] Module installed');
  },

  onEnable: async () => {
    console.log('[newsletters] Module enabled');
  },

  onDisable: async () => {
    console.log('[newsletters] Module disabled');
  },
};

export default newslettersModule;
