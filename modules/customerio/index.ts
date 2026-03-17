import type { GatewazeModule } from '@gatewaze/shared';

const customerioModule: GatewazeModule = {
  id: 'customerio',
  name: 'Customer.io',
  description: 'Marketing automation via Customer.io — sync contacts, segments, activities, and trigger campaigns',
  version: '1.0.0',
  features: [
    'customerio.sync',
    'customerio.segments',
    'customerio.activities',
    'customerio.webhooks',
  ],

  edgeFunctions: [
    'integrations-customerio-sync',
    'integrations-customerio-webhook',
    'integrations-customerio-sync-person',
  ],

  migrations: [
    'migrations/001_customerio_tables.sql',
  ],

  configSchema: {
    CUSTOMERIO_SITE_ID: {
      key: 'CUSTOMERIO_SITE_ID',
      type: 'string',
      required: true,
      description: 'Customer.io Track API site identifier',
    },
    CUSTOMERIO_API_KEY: {
      key: 'CUSTOMERIO_API_KEY',
      type: 'secret',
      required: true,
      description: 'Customer.io Track API key',
    },
    CUSTOMERIO_APP_API_KEY: {
      key: 'CUSTOMERIO_APP_API_KEY',
      type: 'secret',
      required: false,
      description: 'Customer.io App API key (for querying segments/customers)',
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
