import type { GatewazeModule } from '@gatewaze/shared/modules';

const cohortsModule: GatewazeModule = {
  id: 'cohorts',
  type: 'feature',
  group: 'events',
  name: 'Cohorts',
  description: 'Cohort-based event registrations, interest tracking, and payment flows',
  version: '1.0.0',
  features: [
    'cohorts',
    'cohorts.payments',
    'cohorts.interest',
  ],

  edgeFunctions: [
    'cohorts-create-payment',
    'cohorts-interest',
    'cohorts-signup',
  ],

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
