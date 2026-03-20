import type { GatewazeModule } from '@gatewaze/shared/modules';

const gradualIntegrationModule: GatewazeModule = {
  id: 'gradual-integration',
  type: 'integration',
  group: 'integration',
  name: 'Gradual',
  description: 'Gradual platform integration for syncing networking data and processing webhooks',
  version: '1.0.0',
  features: [
    'gradual',
    'gradual.sync',
    'gradual.webhooks',
  ],

  edgeFunctions: [
    'integrations-gradual-sync',
    'integrations-gradual-webhook',
    'integrations-gradual-import-history',
  ],

  onInstall: async () => {
    console.log('[gradual-integration] Module installed');
  },

  onEnable: async () => {
    console.log('[gradual-integration] Module enabled');
  },

  onDisable: async () => {
    console.log('[gradual-integration] Module disabled');
  },
};

export default gradualIntegrationModule;
