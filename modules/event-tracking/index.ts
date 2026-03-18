import type { GatewazeModule } from '@gatewaze/shared';

const eventTrackingModule: GatewazeModule = {
  id: 'event-tracking',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Event Tracking',
  description: 'UTM tracking, referral links, conversion analytics, and attribution for events',
  version: '1.0.0',
  features: [
    'event-tracking',
    'event-tracking.utm',
    'event-tracking.referrals',
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
