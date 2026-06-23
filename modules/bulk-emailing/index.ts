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
    // 008 adds the multi-source engagement model: source/UA/IP/send link on
    // email_events + the email_event_classifications table
    // (spec-newsletter-personalised-delivery.md Part C).
    'migrations/008_engagement_multisource.sql',
    // 009 adds a partial UNIQUE index on (provider_message_id,
    // recipient_email) of email_send_log to prevent webhook attribution
    // cross-talk. Companion to the email-webhook lookup change that
    // disambiguates by recipient email — SendGrid carries it on every
    // event, and the newsletter send path already keys 1:1 anyway.
    'migrations/009_unique_provider_message_per_recipient.sql',
    // 010 Central Sending Service foundation: sender_daily_quota + claim/release
    // quota + generic stuck-row sweeper (spec-central-sending-service.md).
    'migrations/010_send_engine_quota.sql',
    // 011 Central Sending Service BULK domain (Phase 3): bulk_send_recipients
    // queue + bulk_send_batches + bulk_send_id + brand/channel on email_batch_jobs
    // + fanout/claim. Additive + inert until SEND_ENGINE_USE_WORKER + fanout.
    'migrations/011_send_engine_bulk.sql',
    // 012 Channel abstraction (Phase 4): per-(person, channel, topic) consent/
    // opt-out, generalising email "topic" unsubscribe to "(channel, topic)".
    // Additive + inert; consumed by the channel-aware fanout (follow-on).
    'migrations/012_channel_consent.sql',
    // 013 SendGrid delivery-status reconcile RPCs (pull): advance email_send_log
    // to delivered/opened/clicked/bounced from the Email Activity API. Backstops
    // the Event Webhook; on localhost (webhook unreachable) it's the only path.
    'migrations/013_reconcile_email_status.sql',
    // 014 adds the consent_suppressed boolean to email_interactions that the
    // newsletter geo engagement RPCs (newsletters 050-053) reference but no
    // prior migration created. Localhost had it hand-applied during iteration;
    // gap surfaced on AAIF prod rollout 2026-06-23 with "column ei.consent_
    // suppressed does not exist" from the geo materialised view. Additive +
    // backwards-compatible (default false = no suppression).
    'migrations/014_email_interactions_consent_suppressed.sql',
    // 015 captures SendGrid 'deferred' lifecycle events that the email-webhook
    // was silently dropping. Adds 'deferred' to the status enum + deferred_at
    // column + by-domain RPC for the admin dashboard. Reconcile work-list
    // widens to include deferred rows so they advance to delivered/bounced as
    // SG retries resolve. Found while investigating ~9k Yahoo deferrals on a
    // 56k mlopscommunity send (2026-06-23).
    'migrations/015_deferred_status.sql',
  ],

  workers: [
    {
      // 60s heartbeat driving the shared worker drip engine over due bulk
      // recipients (Phase 3). No-op unless SEND_ENGINE_USE_WORKER=true.
      name: 'bulk-emailing:dispatch-drip',
      handler: './workers/dispatch-drip.ts',
    },
    {
      // Pulls real delivery status from the SendGrid Email Activity API into
      // email_send_log so the sending UI reflects delivered/opened/clicked/
      // bounced. Backstop for the Event Webhook (and the only path on localhost).
      name: 'bulk-emailing:reconcile-sendgrid',
      handler: './workers/reconcile-sendgrid.ts',
    },
  ],

  crons: [
    {
      name: 'bulk-emailing-dispatch-drip',
      queue: 'jobs',
      schedule: { every: 60_000 },
      data: { kind: 'bulk-emailing:dispatch-drip' },
    },
    {
      name: 'bulk-emailing-reconcile-sendgrid',
      queue: 'jobs',
      schedule: { every: 180_000 },
      data: { kind: 'bulk-emailing:reconcile-sendgrid' },
    },
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
