import type { GatewazeModule } from '@gatewaze/shared';

const badgeScanningModule: GatewazeModule = {
  id: 'badge-scanning',
  type: 'feature',
  visibility: 'public',
  name: 'Badge Printing & Scanning',
  description: 'Badge printing, QR code scanning, and contact exchange for events',
  version: '1.0.0',
  group: 'events',
  features: [
    'badge-scanning',
    'badge-scanning.templates',
    'badge-scanning.printing',
    'badge-scanning.contact-scans',
  ],

  adminRoutes: [
    {
      path: 'badge-scanning',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'badge-scanning',
      guard: 'admin',
    },
    {
      path: 'badge-scanning/templates',
      component: () => import('./admin/pages/templates'),
      requiredFeature: 'badge-scanning.templates',
      guard: 'admin',
    },
    {
      path: 'badge-scanning/print-jobs',
      component: () => import('./admin/pages/print-jobs'),
      requiredFeature: 'badge-scanning.printing',
      guard: 'admin',
    },
    {
      path: 'badge-scanning/contact-scans',
      component: () => import('./admin/pages/contact-scans'),
      requiredFeature: 'badge-scanning.contact-scans',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/badge-scanning',
      label: 'Badge Scanning',
      icon: 'BadgeCheck',
      requiredFeature: 'badge-scanning',
      parentGroup: 'events',
      order: 30,
    },
  ],

  migrations: [
    'migrations/000_badge_scanning_tables.sql',
    'migrations/001_badge_scanning_event_columns.sql',
    'migrations/002_badge_scanning_rls.sql',
    'migrations/003_badge_scanning_rpc.sql',
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[badge-scanning] Module installed');
  },

  onEnable: async () => {
    console.log('[badge-scanning] Module enabled');
  },

  onDisable: async () => {
    console.log('[badge-scanning] Module disabled');
  },
};

export default badgeScanningModule;
