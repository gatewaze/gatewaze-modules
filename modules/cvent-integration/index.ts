import type { GatewazeModule } from '@gatewaze/shared';

const module: GatewazeModule = {
  id: 'cvent-integration',
  name: 'Cvent',
  description:
    'Cvent event platform integration for syncing registrations and admission items',
  version: '1.0.0',
  type: 'integration',
  visibility: 'public',
  group: 'integration',
  features: ['cvent', 'cvent.sync'],
  edgeFunctions: ['integrations-cvent-sync'],
  configSchema: {},
  onInstall: async () => {
    console.log('[cvent-integration] Module installed');
  },
  onEnable: async () => {
    console.log('[cvent-integration] Module enabled');
  },
  onDisable: async () => {
    console.log('[cvent-integration] Module disabled');
  },
};

export default module;
