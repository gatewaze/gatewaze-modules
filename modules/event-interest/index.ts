import type { GatewazeModule } from '@gatewaze/shared';

const eventInterestModule: GatewazeModule = {
  id: 'event-interest',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Event Interest',
  description: 'Capture expressions of interest from people before event registration opens',
  version: '1.0.0',
  features: [
    'event-interest',
    'event-interest.manage',
  ],

  migrations: [
    'migrations/001_event_interest_tables.sql',
  ],

  edgeFunctions: ['events-interest'],

  adminSlots: [
    {
      slotName: 'event-detail:tab',
      component: () => import('./admin/EventInterestTab'),
      order: 60,
      requiredFeature: 'event-interest',
      meta: { tabId: 'interest', label: 'Interest', icon: 'HeartIcon' },
    },
  ],

  dependencies: ['events'],

  configSchema: {},

  onInstall: async () => {
    console.log('[event-interest] Module installed');
  },

  onEnable: async () => {
    console.log('[event-interest] Module enabled');
  },

  onDisable: async () => {
    console.log('[event-interest] Module disabled');
  },
};

export default eventInterestModule;
