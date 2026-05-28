import type { GatewazeModule } from '@gatewaze/shared';

const eventInvitesModule: GatewazeModule = {
  id: 'event-invites',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Event Invites ',
  description: 'Invite people to events with unique RSVP links and track responses',
  version: '1.0.0',
  features: [
    'event-invites',
    'event-invites.manage',
    'event-invites.analytics',
  ],

  adminRoutes: [
    {
      path: 'invites',
      component: () => import('./admin/EventInvitesPage'),
      requiredFeature: 'event-invites',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/invites',
      label: 'Invites',
      icon: 'Mail',
      requiredFeature: 'event-invites',
      parentGroup: 'events',
      order: 25,
    },
  ],

  edgeFunctions: [
    'event-invite-rsvp',
    'event-invite-admin',
    'event-invite-reminders',
  ],

  adminSlots: [
    {
      slotName: 'event-detail:tab',
      component: () => import('./admin/EventInvitesTab'),
      order: 50,
      requiredFeature: 'event-invites',
      meta: { tabId: 'invites', label: 'Invites', icon: 'EnvelopeIcon' },
    },
  ],

  dependencies: ['events', 'bulk-emailing'],

  migrations: [
    'migrations/001_event_invites.sql',
    'migrations/002_module_event_invites.sql',
    'migrations/003_invite_parties.sql',
    'migrations/004_migrate_existing_invites.sql',
    'migrations/005_invite_sub_events.sql',
    'migrations/006_linked_rsvp.sql',
    'migrations/007_invite_templates.sql',
    'migrations/008_template_background_hidden.sql',
    'migrations/009_allow_multiple_templates.sql',
    'migrations/010_invite_open_links.sql',
    'migrations/011_party_address.sql',
    'migrations/012_event_rsvp_deadline.sql',
    'migrations/013_sub_event_slug.sql',
    'migrations/015_party_address_geocoded.sql',
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[event-invites] Module installed');
  },

  onEnable: async () => {
    console.log('[event-invites] Module enabled');
  },

  onDisable: async () => {
    console.log('[event-invites] Module disabled');
  },
};

export default eventInvitesModule;
