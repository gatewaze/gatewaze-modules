import type { GatewazeModule } from '@gatewaze/shared';

const gradualIntegrationModule: GatewazeModule = {
  id: 'gradual-integration',
  type: 'integration',
  visibility: 'public',
  name: 'Gradual Integration',
  description: 'Sync registrations and attendance with the Gradual platform via webhooks and batch sync',
  version: '1.0.0',
  group: 'integration',
  features: [
    'gradual.sync',
    'gradual.webhooks',
  ],

  edgeFunctions: [
    'integrations-gradual-sync',
    'integrations-gradual-webhook',
    'integrations-gradual-import-history',
  ],

  migrations: [
    'migrations/001_gradual_tables.sql',
  ],

  configSchema: {
    GRADUAL_CLIENT_ID: {
      key: 'GRADUAL_CLIENT_ID',
      type: 'string',
      required: true,
      description: 'Gradual API client ID',
    },
    GRADUAL_BEARER_TOKEN: {
      key: 'GRADUAL_BEARER_TOKEN',
      type: 'secret',
      required: true,
      description: 'Gradual API bearer token for authentication',
    },
  },

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
