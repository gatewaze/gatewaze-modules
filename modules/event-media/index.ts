import type { GatewazeModule } from '@gatewaze/shared';

const eventMediaModule: GatewazeModule = {
  id: 'event-media',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Event Media',
  description: 'Photo and video galleries, media uploads, and album management for events',
  version: '1.0.0',
  features: [
    'event-media',
    'event-media.upload',
    'event-media.albums',
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[event-media] Module installed');
  },

  onEnable: async () => {
    console.log('[event-media] Module enabled');
  },

  onDisable: async () => {
    console.log('[event-media] Module disabled');
  },
};

export default eventMediaModule;
