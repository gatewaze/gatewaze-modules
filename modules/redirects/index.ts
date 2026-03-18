import type { GatewazeModule } from '@gatewaze/shared';

const redirectsModule: GatewazeModule = {
  id: 'redirects',
  type: 'feature',
  visibility: 'public',
  name: 'Redirects',
  description: 'Manage URL redirects and short links with click tracking and analytics',
  version: '1.0.0',
  features: [
    'redirects',
    'redirects.manage',
    'redirects.analytics',
  ],

  migrations: [
    'migrations/001_redirects_tables.sql',
  ],

  adminRoutes: [
    {
      path: 'redirects',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'redirects',
      guard: 'admin',
    },
    {
      path: 'redirects/shortcodes',
      component: () => import('./admin/pages/newsletter/ShortcodeConfigTab'),
      requiredFeature: 'redirects',
      guard: 'admin',
    },
    {
      path: 'redirects/review',
      component: () => import('./admin/pages/newsletter/NeedsReviewTab'),
      requiredFeature: 'redirects',
      guard: 'admin',
    },
    {
      path: 'redirects/:redirectId/detail',
      component: () => import('./admin/pages/detail'),
      requiredFeature: 'redirects',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/admin/redirects',
      label: 'Redirects',
      icon: 'ArrowRightLeft',
      requiredFeature: 'redirects',
      parentGroup: 'admin',
      order: 31,
    },
  ],

  configSchema: {
    SHORTIO_API_KEY: {
      key: 'SHORTIO_API_KEY',
      type: 'secret',
      required: false,
      description: 'Short.io API key for external short link management',
    },
    SHORTIO_DOMAIN: {
      key: 'SHORTIO_DOMAIN',
      type: 'string',
      required: false,
      description: 'Short.io custom domain',
    },
  },

  onInstall: async () => {
    console.log('[redirects] Module installed');
  },

  onEnable: async () => {
    console.log('[redirects] Module enabled');
  },

  onDisable: async () => {
    console.log('[redirects] Module disabled');
  },
};

export default redirectsModule;
