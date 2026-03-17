import type { GatewazeModule } from '@gatewaze/shared';

const cohortsModule: GatewazeModule = {
  id: 'cohorts',
  type: 'feature',
  visibility: 'public',
  name: 'Cohorts',
  description: 'Manage cohort-based learning programs with sessions, enrollments, resources, and instructors',
  version: '1.0.0',
  features: [
    'cohorts',
    'cohorts.sessions',
    'cohorts.enrollments',
    'cohorts.resources',
    'cohorts.instructors',
  ],

  edgeFunctions: [
    'cohorts-create-payment',
    'cohorts-interest',
    'cohorts-signup',
  ],

  migrations: [
    'migrations/001_cohorts_tables.sql',
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[cohorts] Module installed');
  },

  onEnable: async () => {
    console.log('[cohorts] Module enabled');
  },

  onDisable: async () => {
    console.log('[cohorts] Module disabled');
  },
};

export default cohortsModule;
