import type { GatewazeModule } from '@gatewaze/shared';

const eventTrackingModule: GatewazeModule = {
  id: 'event-tracking',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Event Tracking',
  description: 'UTM tracking, referral links, conversion analytics, and attribution for events',
  version: '1.1.0',
  features: [
    'event-tracking',
    'event-tracking.utm',
    'event-tracking.referrals',
  ],

  dependencies: ['events'],

  migrations: [
    'migrations/001_event_tracking_tables.sql',
    'migrations/002_tracking_session_attribution_columns.sql',
    'migrations/003_touch_session_only.sql',
  ],

  adminSlots: [
    {
      slotName: 'event-detail:tab',
      component: () => import('./admin/EventTrackingTab'),
      order: 150,
      requiredFeature: 'event-tracking',
      meta: { tabId: 'tracking', label: 'Tracking', icon: 'SignalIcon' },
    },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[event-tracking] Module installed');
  },

  onEnable: async () => {
    console.log('[event-tracking] Module enabled');
  },

  onDisable: async () => {
    console.log('[event-tracking] Module disabled');
  },
};

export default eventTrackingModule;
