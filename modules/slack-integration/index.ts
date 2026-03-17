import type { GatewazeModule } from '@gatewaze/shared';

const slackIntegrationModule: GatewazeModule = {
  id: 'slack-integration',
  type: 'integration',
  visibility: 'public',
  name: 'Slack Integration',
  description: 'Send notifications, manage channels, and automate workflows via Slack',
  version: '1.0.0',
  features: [
    'slack.notifications',
    'slack.channels',
    'slack.webhooks',
  ],

  migrations: [
    'migrations/001_slack_tables.sql',
  ],

  configSchema: {
    SLACK_BOT_TOKEN: {
      key: 'SLACK_BOT_TOKEN',
      type: 'secret',
      required: true,
      description: 'Slack Bot OAuth token (xoxb-...)',
    },
    SLACK_SIGNING_SECRET: {
      key: 'SLACK_SIGNING_SECRET',
      type: 'secret',
      required: true,
      description: 'Slack app signing secret for webhook verification',
    },
    SLACK_DEFAULT_CHANNEL: {
      key: 'SLACK_DEFAULT_CHANNEL',
      type: 'string',
      required: false,
      description: 'Default Slack channel for notifications',
    },
  },

  onInstall: async () => {
    console.log('[slack-integration] Module installed');
  },

  onEnable: async () => {
    console.log('[slack-integration] Module enabled');
  },

  onDisable: async () => {
    console.log('[slack-integration] Module disabled');
  },
};

export default slackIntegrationModule;
