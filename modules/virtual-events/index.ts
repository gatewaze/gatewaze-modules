import type { GatewazeModule } from '@gatewaze/shared';

const virtualEventsModule: GatewazeModule = {
  id: 'virtual-events',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Virtual Events',
  description: 'Host live virtual events with YouTube streaming and interactive real-time chat',
  version: '1.0.0',
  features: [
    'virtual-events',
    'virtual-events.chat',
    'virtual-events.presenter',
  ],

  dependencies: ['events'],

  adminSlots: [
    {
      slotName: 'event-detail:tab',
      component: () => import('./admin/VirtualEventTab'),
      order: 60,
      requiredFeature: 'virtual-events',
      meta: { tabId: 'virtual', label: 'Virtual', icon: 'VideoCameraIcon' },
    },
  ],

  migrations: [
    'migrations/001_virtual_events_tables.sql',
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[virtual-events] Module installed');
  },

  onEnable: async () => {
    console.log('[virtual-events] Module enabled');
  },

  onDisable: async () => {
    console.log('[virtual-events] Module disabled');
  },
};

export default virtualEventsModule;
