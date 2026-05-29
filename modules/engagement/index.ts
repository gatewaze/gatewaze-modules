import type { GatewazeModule } from '@gatewaze/shared';

const engagementModule: GatewazeModule = {
  id: 'engagement',
  group: 'people',
  type: 'feature',
  visibility: 'public',
  name: 'Engagement',
  description: 'Track member engagement, award badges, surface leaderboards across calendars and events',
  version: '1.0.0',

  features: [
    'engagement',
    'engagement.leaderboard',
    'engagement.badges',
    'engagement.rules',
  ],

  dependencies: ['events'],
  // optionalDependencies: ['calendars', 'event-media', 'event-speakers', 'conversations']

  edgeFunctions: [
    'engagement-record',
    'engagement-record-worker',
    'engagement-rollup',
    'engagement-api',
  ],

  migrations: [
    'migrations/001_engagement_tables.sql',
    'migrations/002_engagement_rollup_views.sql',
    'migrations/003_engagement_default_rules.sql',
    'migrations/004_signal_emission_triggers.sql',
  ],

  adminRoutes: [
    {
      path: 'engagement',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'engagement',
      guard: 'none',
    },
    {
      path: 'engagement/leaderboard',
      component: () => import('./admin/pages/leaderboard'),
      requiredFeature: 'engagement.leaderboard',
      guard: 'none',
    },
    {
      path: 'engagement/badges',
      component: () => import('./admin/pages/badges'),
      requiredFeature: 'engagement.badges',
      guard: 'none',
    },
    {
      path: 'engagement/rules',
      component: () => import('./admin/pages/rules'),
      requiredFeature: 'engagement.rules',
      guard: 'none',
    },
    {
      path: 'engagement/members/:id',
      component: () => import('./admin/pages/member'),
      requiredFeature: 'engagement',
      guard: 'none',
    },
  ],

  adminNavItems: [
    {
      path: '/engagement',
      label: 'Engagement',
      icon: 'Trophy',
      requiredFeature: 'engagement',
      order: 14,
    },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[engagement] Module installed');
  },
  onEnable: async () => {
    console.log('[engagement] Module enabled');
  },
  onDisable: async () => {
    console.log('[engagement] Module disabled');
  },
};

export default engagementModule;
