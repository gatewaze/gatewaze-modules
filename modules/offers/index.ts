import type { GatewazeModule } from '@gatewaze/shared';

const offersModule: GatewazeModule = {
  id: 'offers',
  type: 'feature',
  visibility: 'public',
  name: 'Offers',
  description: 'Create and distribute offers with acceptance tracking and conversion analytics',
  version: '1.0.0',
  features: [
    'offers',
    'offers.manage',
    'offers.tracking',
  ],

  edgeFunctions: [
    'integrations-track-offer',
  ],

  migrations: [
    'migrations/001_offers_tables.sql',
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[offers] Module installed');
  },

  onEnable: async () => {
    console.log('[offers] Module enabled');
  },

  onDisable: async () => {
    console.log('[offers] Module disabled');
  },
};

export default offersModule;
