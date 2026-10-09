import type { GatewazeModule } from '@gatewaze/shared';

const slackIntegrationModule: GatewazeModule = {
  id: 'slack',
  group: 'communications',
  type: 'integration',
  visibility: 'public',
  name: 'Slack',
  description: 'Send notifications, manage channels, and automate workflows via Slack',
  version: '1.1.1',
  features: [
    'slack',
    'slack.notifications',
    'slack.channels',
    'slack.webhooks',
  ],

  migrations: [
    'migrations/001_slack_tables.sql',
    'migrations/002_slack_invitation_rpcs.sql',
    'migrations/003_portal_self_service.sql',
  ],

  edgeFunctions: [
    'integrations-slack-list-channels',
    'integrations-slack-notify',
    'integrations-slack-oauth-callback',
    'integrations-slack-request-invite',
  ],

  adminRoutes: [
    { path: 'slack/invitations', component: () => import('./admin/pages/invitations'), requiredFeature: 'slack', guard: 'none' },
  ],
  adminNavItems: [
    { path: '/slack/invitations', label: 'Slack', icon: 'MessageSquare', requiredFeature: 'slack', order: 18 },
  ],

  // Portal: a public "Slack" page where a signed-in visitor requests their own
  // invitation (the address is resolved server-side from their session, never
  // taken from the form). Copy comes from the SLACK_WORKSPACE_* / SLACK_COMMUNITY_*
  // config keys below via the anon-readable integrations_slack_public_info RPC.
  portalNav: {
    label: 'Slack',
    path: '/slack',
    icon: 'msg',
    order: 40,
  },
  portalShell: {
    rail: { label: 'Slack', full: 'Slack community', icon: 'msg', order: 40, visibility: 'public' },
    nav: [],
    publicNav: [],
  },
  portalRoutes: [
    { path: '/slack', component: () => import('./portal/pages/index') },
  ],

  // Injects a "Slack" section into the people-detail dashboard: send an invite to
  // an existing person and show the progress of their invitation.
  adminSlots: [
    {
      slotName: 'person-detail:subscriptions',
      component: () => import('./admin/components/PersonSlackInvite'),
      order: 20,
      requiredFeature: 'slack',
    },
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
    // Public page copy (read by anyone through integrations_slack_public_info).
    SLACK_WORKSPACE_NAME: {
      key: 'SLACK_WORKSPACE_NAME',
      type: 'string',
      required: false,
      description: 'Workspace name shown on the portal Slack page (e.g. "AAIF Community")',
    },
    SLACK_WORKSPACE_URL: {
      key: 'SLACK_WORKSPACE_URL',
      type: 'string',
      required: false,
      description: 'Workspace URL for the "Open Slack" link (e.g. https://example.slack.com)',
    },
    SLACK_COMMUNITY_DESCRIPTION: {
      key: 'SLACK_COMMUNITY_DESCRIPTION',
      type: 'string',
      required: false,
      description: 'One or two sentences about the community Slack, shown on the portal page',
    },
    SLACK_HIGHLIGHT_CHANNELS: {
      key: 'SLACK_HIGHLIGHT_CHANNELS',
      type: 'string',
      required: false,
      description: 'Comma-separated channel names to highlight on the portal page (e.g. general, introduce-yourself, job-posts)',
    },
  },

  onInstall: async () => {
    console.log('[slack] Module installed');
  },

  onEnable: async () => {
    console.log('[slack] Module enabled');
  },

  onDisable: async () => {
    console.log('[slack] Module disabled');
  },
};

export default slackIntegrationModule;
