import type { GatewazeModule } from '@gatewaze/shared';

const gradualIntegrationModule: GatewazeModule = {
  id: 'gradual',
  type: 'integration',
  visibility: 'public',
  name: 'Gradual',
  description: 'Sync registrations and attendance with the Gradual platform via webhooks and batch sync',
  version: '1.0.0',
  group: 'integrations',
  features: [
    'gradual.sync',
    'gradual.webhooks',
  ],

  // luma is required: the webhook and import-history functions import the shared
  // registration helper (createFullRegistration/cancelRegistration) from the luma
  // module's functions/_shared/lumaRegistration.ts.
  dependencies: ['events', 'luma'],

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
    console.log('[gradual] Module installed');
  },

  onEnable: async () => {
    console.log('[gradual] Module enabled');
  },

  onDisable: async () => {
    console.log('[gradual] Module disabled');
  },
};

export default gradualIntegrationModule;
