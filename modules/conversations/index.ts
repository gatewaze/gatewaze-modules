import type { GatewazeModule } from '@gatewaze/shared';

const conversationsModule: GatewazeModule = {
  id: 'conversations',
  group: 'people',
  type: 'feature',
  visibility: 'public',
  name: 'Conversations',
  description: 'Direct messages, channels, and real-time chat across calendars and events',
  version: '1.0.0',

  features: [
    'conversations',
    'conversations.dms',
    'conversations.channels',
    'conversations.calendar-channels',
    'conversations.event-channels',
    'conversations.notifications',
    'conversations.usernames',
  ],

  dependencies: ['events'],
  // optionalDependencies are not enforced at install time but indicate which
  // sister modules unlock additional features (calendar channels, engagement
  // signals, virtual-events visual reuse).
  // optionalDependencies: ['calendars', 'engagement', 'virtual-events'],

  edgeFunctions: [
    'conversations-api',
    'conversations-websocket-auth',
    'conversations-notifications',
  ],

  migrations: [
    'migrations/001_conversations_tables.sql',
    'migrations/002_conversations_rls.sql',
    'migrations/003_username_column.sql',
    'migrations/004_seed_default_channels.sql',
  ],

  adminRoutes: [
    {
      path: 'conversations',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'conversations',
      guard: 'none',
    },
    {
      path: 'conversations/all',
      component: () => import('./admin/pages/conversations'),
      requiredFeature: 'conversations',
      guard: 'none',
    },
    {
      path: 'conversations/:id',
      component: () => import('./admin/pages/conversation'),
      requiredFeature: 'conversations',
      guard: 'none',
    },
    {
      path: 'conversations/usernames',
      component: () => import('./admin/pages/usernames'),
      requiredFeature: 'conversations.usernames',
      guard: 'none',
    },
    {
      path: 'conversations/settings',
      component: () => import('./admin/pages/settings'),
      requiredFeature: 'conversations',
      guard: 'none',
    },
  ],

  adminNavItems: [
    {
      path: '/conversations',
      label: 'Conversations',
      icon: 'ChatBubble',
      requiredFeature: 'conversations',
      order: 15,
    },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[conversations] Module installed');
  },

  onEnable: async () => {
    console.log('[conversations] Module enabled');
  },

  onDisable: async () => {
    console.log('[conversations] Module disabled');
  },
};

export default conversationsModule;
