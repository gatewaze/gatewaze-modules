import type { GatewazeModule } from '@gatewaze/shared';

const complianceModule: GatewazeModule = {
  id: 'compliance',
  type: 'feature',
  visibility: 'public',
  name: 'Compliance',
  description: 'GDPR, CCPA, and SOC 2 compliance tools — consent records, privacy requests, data breach tracking, and audit logging',
  version: '1.0.0',
  features: [
    'compliance',
    'compliance.consent',
    'compliance.privacy_requests',
    'compliance.data_breaches',
    'compliance.audit',
  ],

  migrations: [
    'migrations/001_compliance_tables.sql',
  ],

  adminRoutes: [
    {
      path: 'compliance',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'compliance',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/admin/compliance',
      label: 'Compliance',
      icon: 'Shield',
      requiredFeature: 'compliance',
      parentGroup: 'admin',
      order: 30,
    },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[compliance] Module installed');
  },

  onEnable: async () => {
    console.log('[compliance] Module enabled');
  },

  onDisable: async () => {
    console.log('[compliance] Module disabled');
  },
};

export default complianceModule;
