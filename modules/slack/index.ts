import type { GatewazeModule } from '@gatewaze/shared';

const slackIntegrationModule: GatewazeModule = {
  id: 'slack',
  group: 'communications',
  type: 'integration',
  visibility: 'public',
  name: 'Slack',
  description: 'Send notifications, manage channels, and automate workflows via Slack',
  version: '1.3.1',
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
    'migrations/004_welcome_dm.sql',
    'migrations/005_people_sync.sql',
  ],

  edgeFunctions: [
    'integrations-slack-list-channels',
    'integrations-slack-notify',
    'integrations-slack-oauth-callback',
    'integrations-slack-request-invite',
  ],

  adminRoutes: [
    { path: 'slack/invitations', component: () => import('./admin/pages/invitations'), requiredFeature: 'slack', guard: 'none' },
    { path: 'slack/welcome', component: () => import('./admin/pages/welcome'), requiredFeature: 'slack', guard: 'none' },
  ],
  adminNavItems: [
    { path: '/slack/invitations', label: 'Slack', icon: 'MessageSquare', requiredFeature: 'slack', order: 18 },
    { path: '/slack/welcome', label: 'Slack welcome DM', icon: 'MessageSquare', requiredFeature: 'slack', order: 19 },
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

  // Welcome-DM routes: Slack events + OAuth return under /internal/ (each
  // self-authenticating), admin routes behind the super_admin gate.
  apiRoutes: async (app: unknown, ctx?: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- express/ctx shapes are host-provided
    registerRoutes(app as any, ctx as any);
  },

  // Sends one welcome DM; queued with a delay by the events route. One at a
  // time keeps well inside Slack's per-user posting limits.
  workers: [
    { name: 'slack:welcome-dm', handler: './workers/welcome-dm.ts', concurrency: 1 },
    // Links every workspace member to people; started from the admin page.
    { name: 'slack:sync-members', handler: './workers/sync-members.ts', concurrency: 1 },
  ],

  configSchema: {
    SLACK_BOT_TOKEN: {
      key: 'SLACK_BOT_TOKEN',
      type: 'secret',
      encrypted: true,
      required: true,
      description: 'Slack Bot OAuth token (xoxb-...)',
    },
    SLACK_SIGNING_SECRET: {
      key: 'SLACK_SIGNING_SECRET',
      type: 'secret',
      encrypted: true,
      required: true,
      description: 'Slack app signing secret for webhook verification',
    },
    // The Slack app's OAuth client, for connecting the welcome-DM sender's account.
    SLACK_CLIENT_ID: {
      key: 'SLACK_CLIENT_ID',
      type: 'string',
      required: false,
      description: 'Slack app client ID (Basic Information → App Credentials)',
    },
    SLACK_CLIENT_SECRET: {
      key: 'SLACK_CLIENT_SECRET',
      type: 'secret',
      encrypted: true,
      required: false,
      description: 'Slack app client secret',
    },
    // Welcome DM to new members, sent from the connected person's own account.
    SLACK_WELCOME_ENABLED: {
      key: 'SLACK_WELCOME_ENABLED',
      type: 'boolean',
      required: false,
      default: 'false',
      description: 'Send a welcome DM when someone joins the workspace',
    },
    SLACK_WELCOME_MESSAGE: {
      key: 'SLACK_WELCOME_MESSAGE',
      type: 'string',
      required: false,
      description: "Welcome message text. {first_name} and {name} are filled in from the new member's profile.",
    },
    SLACK_WELCOME_DELAY_MINUTES: {
      key: 'SLACK_WELCOME_DELAY_MINUTES',
      type: 'number',
      required: false,
      default: '5',
      description: 'Minutes to wait after someone joins before the welcome is sent',
    },
    // Slack members → people, by email. The link is attributes.slack_user_id.
    SLACK_PEOPLE_SYNC: {
      key: 'SLACK_PEOPLE_SYNC',
      type: 'select',
      required: false,
      default: 'link',
      label: 'Slack members in People',
      description: 'When someone joins (and on a full sync): add their Slack user ID to the person with the same email, and optionally create a person for members nobody has yet.',
      options: [
        { label: 'Off', value: 'off' },
        { label: 'Link existing people', value: 'link' },
        { label: 'Link, and create missing people', value: 'create' },
      ],
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
