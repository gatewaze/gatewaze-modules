import type { GatewazeModule } from '@gatewaze/shared';

const eventInvitesModule: GatewazeModule = {
  id: 'event-invites',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Event Invites',
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
  ],

  dependencies: ['events', 'calendars'],

  migrations: [
    'migrations/001_event_invites.sql',
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
