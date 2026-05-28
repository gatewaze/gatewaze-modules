import type { GatewazeModule } from '@gatewaze/shared';

const module: GatewazeModule = {
  id: 'cvent',
  name: 'Cvent',
  description:
    'Cvent event platform integration for syncing registrations and admission items',
  version: '1.0.0',
  type: 'integration',
  visibility: 'public',
  group: 'events',
  features: ['cvent', 'cvent.sync'],
  edgeFunctions: ['integrations-cvent-sync'],
  configSchema: {},
  onInstall: async () => {
    console.log('[cvent] Module installed');
  },
  onEnable: async () => {
    console.log('[cvent] Module enabled');
  },
  onDisable: async () => {
    console.log('[cvent] Module disabled');
  },
};

export default module;
