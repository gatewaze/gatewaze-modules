import type { GatewazeModule } from '@gatewaze/shared';

const kioskModule: GatewazeModule = {
  id: 'kiosk',
  type: 'feature',
  visibility: 'premium',
  group: 'events',
  name: 'Kiosk',
  description: 'Allow admins to search and update registrant information on-site',
  version: '1.0.0',
  features: [
    'kiosk',
    'kiosk.manage',
  ],

  dependencies: ['events'],

  migrations: [],
  configSchema: {},

  onInstall: async () => {
    console.log('[kiosk] Module installed');
  },

  onEnable: async () => {
    console.log('[kiosk] Module enabled');
  },

  onDisable: async () => {
    console.log('[kiosk] Module disabled');
  },
};

export default kioskModule;
