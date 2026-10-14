import type { GatewazeModule } from '@gatewaze/shared';

/**
 * Email Reputation
 *
 * Measures every newsletter and broadcast send by mailbox provider and alerts
 * when one provider's open rate falls far below the others. That pattern is
 * what a provider filing a sending domain's mail as spam looks like: Gmail
 * accepts the mail, then hardly anyone there opens it.
 *
 * Phase 1 of spec-email-reputation-module.md. It only reads send data and
 * never changes who receives a send. Later phases limit sends to a provider
 * while a domain's reputation recovers.
 */
const emailReputationModule: GatewazeModule = {
  id: 'email-reputation',
  group: 'communications',
  type: 'feature',
  visibility: 'public',
  name: 'Email Reputation',
  description:
    'Open rates by mailbox provider for every send, with an alert when one provider (usually Gmail) falls far below the rest.',
  version: '0.1.2',
  features: ['email-reputation'],

  migrations: [
    'migrations/001_email_reputation.sql',
    // Scan the 3 most recent sends for unresolved domains, not 20 (timed out on AAIF).
    'migrations/002_unresolved_domains_recent_three.sql',
  ],

  workers: [
    { name: 'email-reputation:tick', handler: './workers/tick.ts' },
  ],

  crons: [
    {
      name: 'email-reputation-tick',
      queue: 'jobs',
      // Opens build up over hours, and each run is time-budgeted, so every 30
      // minutes keeps recent sends current without loading the worker.
      schedule: { every: 30 * 60_000 },
      data: { kind: 'email-reputation:tick' },
    },
  ],

  adminRoutes: [
    {
      path: 'email-reputation',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'email-reputation',
      guard: 'none',
    },
  ],

  adminNavItems: [
    {
      path: '/email-reputation',
      label: 'Email Reputation',
      icon: 'ShieldCheck',
      requiredFeature: 'email-reputation',
      defaultSection: 'Communications',
      defaultLocation: 'sidebar',
      order: 45,
    },
  ],

  configSchema: {
    slack_webhook_url: {
      key: 'slack_webhook_url',
      type: 'secret',
      label: 'Slack webhook for alerts',
      description: 'Optional Slack incoming webhook (https://hooks.slack.com/services/...). Alerts are posted here as well as shown in the admin.',
      required: false,
    },
    max_open_rate_ratio: {
      key: 'max_open_rate_ratio',
      type: 'number',
      label: 'Alert when a provider opens less than this fraction of the others',
      description: 'Default 0.33. A provider at 2% when others are at 30% is 0.07.',
      required: false,
    },
    min_delivered: {
      key: 'min_delivered',
      type: 'number',
      label: 'Minimum delivered messages to judge a provider',
      description: 'Default 500. Smaller samples are too noisy.',
      required: false,
    },
    min_baseline_open_rate: {
      key: 'min_baseline_open_rate',
      type: 'number',
      label: 'Minimum open rate at other providers',
      description: 'Default 0.10. Below this the whole send is unopened, which is not a single provider filtering it.',
      required: false,
    },
    backfill_days: {
      key: 'backfill_days',
      type: 'number',
      label: 'Days of past sends to measure on first install',
      description: 'Default 120.',
      required: false,
    },
  },
};

export default emailReputationModule;
