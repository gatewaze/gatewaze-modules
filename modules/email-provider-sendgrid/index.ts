import type { GatewazeModule } from '@gatewaze/shared';

const emailProviderSendgridModule: GatewazeModule = {
  id: 'email-provider-sendgrid',
  group: 'communications',
  type: 'feature',
  visibility: 'public',
  name: 'Email Provider: SendGrid',
  description: 'SendGrid email provider for the bulk emailing module. Handles sending emails and processing SendGrid webhook events.',
  version: '1.0.0',
  features: ['email-provider-sendgrid'],
  dependencies: ['bulk-emailing'],
  migrations: [],
  edgeFunctions: [],
  functionFiles: ['provider.ts:sendgrid.ts'],

  configSchema: {
    SENDGRID_API_KEY: {
      key: 'SENDGRID_API_KEY',
      type: 'secret',
      required: true,
      description: 'SendGrid API key for sending emails',
    },
    SENDGRID_WEBHOOK_VERIFICATION_KEY: {
      key: 'SENDGRID_WEBHOOK_VERIFICATION_KEY',
      type: 'secret',
      required: false,
      description: 'SendGrid signed event webhook public key for verifying webhook authenticity',
    },
  },

  onInstall: async () => {
    console.log('[email-provider-sendgrid] Provider installed');
  },

  onEnable: async () => {
    console.log('[email-provider-sendgrid] Provider enabled');
  },

  onDisable: async () => {
    console.log('[email-provider-sendgrid] Provider disabled');
  },
};

export default emailProviderSendgridModule;
