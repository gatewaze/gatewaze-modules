import type { GatewazeModule } from '@gatewaze/shared';

const complianceModule: GatewazeModule = {
  id: 'compliance',
  type: 'feature',
  visibility: 'hidden',
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
