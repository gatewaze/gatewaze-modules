import type { GatewazeModule } from '@gatewaze/shared';

const lumaIntegrationModule: GatewazeModule = {
  id: 'luma-integration',
  type: 'integration',
  visibility: 'public',
  name: 'Luma Integration',
  description: 'Sync events and registrations from Luma — process webhooks, CSV imports, and issue discount codes',
  version: '1.0.0',
  features: [
    'luma.sync',
    'luma.webhooks',
    'luma.discounts',
  ],

  edgeFunctions: [
    'integrations-luma-issue-discount',
    'integrations-luma-process-csv',
    'integrations-luma-process-registration',
    'integrations-luma-webhook',
  ],

  migrations: [
    'migrations/001_luma_tables.sql',
  ],

  configSchema: {
    LUMA_API_KEY: {
      key: 'LUMA_API_KEY',
      type: 'secret',
      required: true,
      description: 'Luma API key for accessing event and registration data',
    },
    LUMA_WEBHOOK_SECRET: {
      key: 'LUMA_WEBHOOK_SECRET',
      type: 'secret',
      required: false,
      description: 'Luma webhook signing secret for verification',
    },
  },

  onInstall: async () => {
    console.log('[luma-integration] Module installed');
  },

  onEnable: async () => {
    console.log('[luma-integration] Module enabled');
  },

  onDisable: async () => {
    console.log('[luma-integration] Module disabled');
  },
};

export default lumaIntegrationModule;
