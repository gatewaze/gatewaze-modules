import type { GatewazeModule } from '@gatewaze/shared';

const discountsModule: GatewazeModule = {
  id: 'discounts',
  type: 'feature',
  visibility: 'public',
  name: 'Discounts',
  description: 'Create, distribute, and track discount codes for events and products',
  version: '1.0.0',
  features: [
    'discounts',
    'discounts.manage',
    'discounts.claimants',
  ],

  migrations: [
    'migrations/001_discounts_tables.sql',
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[discounts] Module installed');
  },

  onEnable: async () => {
    console.log('[discounts] Module enabled');
  },

  onDisable: async () => {
    console.log('[discounts] Module disabled');
  },
};

export default discountsModule;
