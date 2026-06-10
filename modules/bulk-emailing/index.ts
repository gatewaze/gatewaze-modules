import type { GatewazeModule } from '@gatewaze/shared';

const bulkEmailingModule: GatewazeModule = {
  id: 'bulk-emailing',
  group: 'communications',
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

  dependencies: ['events'],

  adminSlots: [
    {
      slotName: 'event-detail:tab',
      component: () => import('./admin/components/EventCommunicationsTab'),
      order: 130,
      requiredFeature: 'bulk-emailing',
      meta: { tabId: 'communications', label: 'Comms', icon: 'ChatBubbleLeftRightIcon' },
    },
  ],

  edgeFunctions: [
    'email-batch-send',
    'email-retry-send',
    'email-webhook',
  ],

  migrations: [
    'migrations/001_bulk_emailing_tables.sql',
    'migrations/002_email_hardening.sql',
    'migrations/003_communication_settings.sql',
    'migrations/005_template_scope.sql',
    'migrations/006_email_batch_polymorphic_source.sql',
    // 007 adds newsletter block-level click-tracking resolution columns to
    // email_interactions (spec-newsletter-link-tracking.md).
    'migrations/007_newsletter_link_tracking.sql',
  ],

  configSchema: {
    EMAIL_PROVIDER: {
      key: 'EMAIL_PROVIDER',
      type: 'string',
      required: false,
      description: 'Active email provider sub-module name (e.g., "sendgrid", "ses"). Defaults to "sendgrid".',
    },
    EMAIL_BOT_DETECTOR: {
      key: 'EMAIL_BOT_DETECTOR',
      type: 'string',
      required: false,
      description: 'Active bot detector sub-module name (e.g., "signals"). Leave empty to disable bot detection.',
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
