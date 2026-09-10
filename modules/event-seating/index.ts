import type { GatewazeModule } from '@gatewaze/shared';

const eventSeatingModule: GatewazeModule = {
  id: 'event-seating',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Event Seating',
  description: 'Drag-and-drop seating plans for guests who have accepted their invite',
  version: '1.1.0',

  features: [
    'event-seating',
    'event-seating.manage',
  ],

  dependencies: ['events', 'event-invites'],

  adminSlots: [
    {
      slotName: 'event-detail:tab',
      component: () => import('./admin/EventSeatingTab'),
      order: 55,
      requiredFeature: 'event-seating',
      // Icon names resolve through admin's heroIconResolver ICON_MAP, which
      // falls back to a generic cube for anything it does not carry.
      // TableCellsIcon is not in that map; UserGroupIcon is.
      meta: { tabId: 'seating', label: 'Seating', icon: 'UserGroupIcon' },
    },
  ],

  migrations: [
    'migrations/001_event_seating.sql',
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[event-seating] Module installed');
  },

  onEnable: async () => {
    console.log('[event-seating] Module enabled');
  },

  onDisable: async () => {
    console.log('[event-seating] Module disabled');
  },
};

export default eventSeatingModule;
