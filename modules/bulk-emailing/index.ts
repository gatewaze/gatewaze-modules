import type { GatewazeModule } from '@gatewaze/shared';

const bulkEmailingModule: GatewazeModule = {
  id: 'bulk-emailing',
  type: 'feature',
  visibility: 'public',
  name: 'Bulk Emailing',
  description: 'Send ad-hoc bulk emails to segments and contact lists with template support and delivery tracking',
  version: '1.0.0',
  features: [
    'bulk-emailing',
    'bulk-emailing.send',
    'bulk-emailing.templates',
    'bulk-emailing.tracking',
  ],

  edgeFunctions: [
    'email-batch-send',
  ],

  migrations: [
    'migrations/001_bulk_emailing_tables.sql',
  ],

  configSchema: {
    SENDGRID_API_KEY: {
      key: 'SENDGRID_API_KEY',
      type: 'secret',
      required: true,
      description: 'SendGrid API key for sending bulk emails',
    },
    BULK_EMAIL_FROM_ADDRESS: {
      key: 'BULK_EMAIL_FROM_ADDRESS',
      type: 'string',
      required: true,
      description: 'Default sender email address for bulk sends',
    },
    BULK_EMAIL_FROM_NAME: {
      key: 'BULK_EMAIL_FROM_NAME',
      type: 'string',
      required: false,
      description: 'Default sender display name',
    },
  },

  onInstall: async () => {
    console.log('[bulk-emailing] Module installed');
  },

  onEnable: async () => {
    console.log('[bulk-emailing] Module enabled');
  },

  onDisable: async () => {
    console.log('[bulk-emailing] Module disabled');
  },
};

export default bulkEmailingModule;
