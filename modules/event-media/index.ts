import type { GatewazeModule } from '@gatewaze/shared';

const eventMediaModule: GatewazeModule = {
  id: 'event-media',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Event Media',
  description: 'Photo and video galleries, media uploads, and album management for events',
  version: '1.18.0',
  features: [
    'event-media',
    'event-media.upload',
    'event-media.albums',
    'event-media.guest-uploads',
  ],

  migrations: [
    'migrations/001_event_media_tables.sql',
    'migrations/002_event_media_albums.sql',
    'migrations/003_guest_upload_links.sql',
    'migrations/004_face_filters.sql',
  ],

  apiRoutes: async (app: unknown, context?: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    await registerRoutes(app as never, context as never);
  },

  edgeFunctions: [
    'media-combine-chunks',
    'media-get-youtube-upload-url',
    'media-process-image',
    'media-process-youtube-uploads',
    'media-process-zip',
    'media-upload-youtube',
  ],

  adminSlots: [
    {
      slotName: 'event-detail:tab',
      component: () => import('./admin/EventMediaTab'),
      order: 140,
      requiredFeature: 'event-media',
      meta: { tabId: 'media', label: 'Media', icon: 'PhotoIcon' },
    },
  ],

  workers: [
    {
      name: 'media:process-zip',
      handler: './workers/process-zip.ts',
      concurrency: 1, // Process one zip at a time to manage memory
    },
  ],

  dependencies: ['events', 'event-sponsors'],

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
