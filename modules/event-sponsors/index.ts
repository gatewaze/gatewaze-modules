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
    'migrations/002_triage_adapter.sql',
    'migrations/003_register_with_platform.sql',
    // 004: the sponsor-team schema the admin UI always wrote to but no
    // migration ever created (events_registrations.sponsor_team_id +
    // is_primary_contact + 'sponsor_staff' registration_type + view refresh).
    'migrations/004_sponsor_team_columns.sql',
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

  dependencies: ['content-platform', 'events'],

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
