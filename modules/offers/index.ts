import type { GatewazeModule } from '@gatewaze/shared/modules';

const offersModule: GatewazeModule = {
  id: 'offers',
  type: 'feature',
  group: 'feature',
  name: 'Offers',
  description: 'Offer tracking and management for events and campaigns',
  version: '1.0.0',
  features: [
    'offers',
    'offers.tracking',
  ],

  edgeFunctions: [
    'integrations-track-offer',
  ],

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
