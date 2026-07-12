import type { GatewazeModule } from '@gatewaze/shared';

/**
 * Videos module — the canonical video object.
 *
 * One `videos` row per (YouTube-hosted) video, referenced by resources blocks,
 * events (`event_videos`), and podcasts, registered with the content platform
 * (inbox / triage / keyword topic-tagging), and embedded for related-content.
 * Populated by the YouTube channel scraper (contributed by the `video-scraper`
 * module). See gatewaze-environments/specs/spec-videos-module.md.
 */
const videosModule: GatewazeModule = {
  id: 'videos',
  group: 'content',
  type: 'feature',
  visibility: 'public',
  name: 'Videos',
  description: 'Canonical video object (YouTube-hosted); referenced by resources, events, and podcasts, and surfaced in related content.',
  version: '1.0.0',
  features: ['videos', 'videos.manage'],

  dependencies: ['content-platform'],

  migrations: [
    'migrations/001_videos.sql',
    'migrations/002_register_with_platform.sql',
    'migrations/003_keyword_adapter.sql',
    'migrations/004_triage_adapter.sql',
  ],

  apiRoutes: async (app: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRoutes(app as any);
  },

  configSchema: {},

  onInstall: async () => {
    console.log('[videos] Module installed');
  },
  onEnable: async () => {
    console.log('[videos] Module enabled — registered as content type "video".');
  },
};

export default videosModule;
