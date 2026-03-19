import type { GatewazeModule } from '@gatewaze/shared';

const eventSponsorsModule: GatewazeModule = {
  id: 'event-sponsors',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Event Sponsors',
  description: 'Sponsor profiles, sponsorship tiers, booth assignments, and sponsor team management',
  version: '1.0.0',
  features: [
    'event-sponsors',
    'event-sponsors.manage',
    'event-sponsors.teams',
  ],

  migrations: [
    'migrations/001_event_sponsors_tables.sql',
  ],

  adminSlots: [
    {
      slotName: 'event-detail:tab',
      component: () => import('./admin/EventSponsorsTab'),
      order: 30,
      requiredFeature: 'event-sponsors',
      meta: { tabId: 'sponsors', label: 'Sponsors', icon: 'BuildingOfficeIcon' },
    },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[event-sponsors] Module installed');
  },

  onEnable: async () => {
    console.log('[event-sponsors] Module enabled');
  },

  onDisable: async () => {
    console.log('[event-sponsors] Module disabled');
  },
};

export default eventSponsorsModule;
