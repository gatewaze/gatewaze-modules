import type { GatewazeModule } from '@gatewaze/shared';

const customerioModule: GatewazeModule = {
  id: 'customerio',
  type: 'integration',
  visibility: 'public',
  group: 'integrations',
  name: 'Customer.io',
  description: 'Customer.io CRM integration for syncing contacts, tracking events, and processing webhooks',
  version: '1.0.0',
  features: [
    'customerio',
    'customerio.sync',
    'customerio.webhooks',
    'customerio.tracking',
  ],

  edgeFunctions: [
    'integrations-customerio-sync',
    'integrations-customerio-webhook',
    'integrations-customerio-sync-person',
    'integrations-customerio-process-events',
    'integrations-track-event',
  ],

  configSchema: {
    CUSTOMERIO_SITE_ID: {
      key: 'CUSTOMERIO_SITE_ID',
      type: 'string',
      required: true,
      description: 'Customer.io site ID',
    },
    CUSTOMERIO_API_KEY: {
      key: 'CUSTOMERIO_API_KEY',
      type: 'secret',
      required: true,
      description: 'Customer.io API key for tracking and syncing',
    },
  },

  onInstall: async () => {
    console.log('[customerio] Module installed');
  },

  onEnable: async () => {
    console.log('[customerio] Module enabled');
  },

  onDisable: async () => {
    console.log('[customerio] Module disabled');
  },
};

export default customerioModule;
