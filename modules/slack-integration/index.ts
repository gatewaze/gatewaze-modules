import type { GatewazeModule } from '@gatewaze/shared';

const slackIntegrationModule: GatewazeModule = {
  id: 'slack-integration',
  type: 'integration',
  visibility: 'public',
  name: 'Slack Integration',
  description: 'Send notifications, manage channels, and automate workflows via Slack',
  version: '1.0.0',
  features: [
    'slack',
    'slack.notifications',
    'slack.channels',
    'slack.webhooks',
  ],

  migrations: [
    'migrations/001_slack_tables.sql',
  ],

  edgeFunctions: [
    'integrations-slack-list-channels',
    'integrations-slack-notify',
    'integrations-slack-oauth-callback',
  ],

  adminRoutes: [
    { path: 'slack/invitations', component: () => import('./admin/pages/invitations'), requiredFeature: 'slack', guard: 'none' },
  ],
  adminNavItems: [
    { path: '/slack/invitations', label: 'Slack', icon: 'MessageSquare', requiredFeature: 'slack', order: 18 },
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
