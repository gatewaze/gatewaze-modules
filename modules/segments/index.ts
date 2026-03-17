import type { GatewazeModule } from '@gatewaze/shared';

const segmentsModule: GatewazeModule = {
  id: 'segments',
  type: 'feature',
  visibility: 'public',
  name: 'Segments',
  description: 'Create and manage audience segments for targeted communications and analytics',
  version: '1.0.0',
  features: [
    'segments',
    'segments.create',
    'segments.manage',
  ],

  migrations: [
    'migrations/001_segments_tables.sql',
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[segments] Module installed');
  },

  onEnable: async () => {
    console.log('[segments] Module enabled');
  },

  onDisable: async () => {
    console.log('[segments] Module disabled');
  },
};

export default segmentsModule;
