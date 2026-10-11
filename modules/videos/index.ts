import type { GatewazeModule } from '@gatewaze/shared';

/**
 * Videos module — the canonical video object, and the place video is managed
 * before it reaches a platform.
 *
 * It began as a read-only catalogue of YouTube-hosted videos, populated by the
 * channel scraper and referenced by resources blocks, events (`event_videos`)
 * and podcasts. Migration 007 inverted that: Gatewaze now holds the master
 * file, a third-party editor uploads it against a talk, and publication is a
 * separate scheduled act. See
 * gatewaze-roadmap/specs/spec-videos-publishing-and-platform-metrics.md,
 * §16 onwards.
 */
const videosModule: GatewazeModule = {
  id: 'videos',
  group: 'content',
  type: 'feature',
  visibility: 'public',
  name: 'Videos',
  description:
    'Video masters, shorts and scheduled publication. Editors upload against a talk or episode; '
    + 'Gatewaze holds the file and publishes on a schedule.',
  version: '1.4.0',
  features: ['videos', 'videos.manage', 'videos.edit'],

  dependencies: ['content-platform'],

  migrations: [
    'migrations/001_videos.sql',
    'migrations/002_register_with_platform.sql',
    'migrations/003_keyword_adapter.sql',
    'migrations/004_triage_adapter.sql',
    'migrations/005_rls.sql',
    'migrations/006_event_link_rpcs.sql',
    'migrations/007_assets_editor_workflow.sql',
    // 008 moves generated copy onto the PUBLICATION and binds the four
    // lf-agents recipes. The two AAIF YouTube channels publish measurably
    // different copy, so one set of words per video is the wrong unit.
    'migrations/008_publication_copy.sql',
    // 009 adds the publishing accounts themselves: credentials, collection
    // state, and the metrics they produce. Closes the FK that
    // video_publications.connection_id had pointed at nothing since 007.
    'migrations/009_platform_connections.sql',
  ],

  apiRoutes: async (app: unknown, ctx?: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- express/ctx shapes are host-provided
    registerRoutes(app as any, ctx as any);
  },

  adminRoutes: [
    {
      // guard 'none' puts this at /videos rather than /admin/videos, so a
      // third-party editor lands on their own workspace rather than inside the
      // admin section. The authorisation is per subject in the API, not the
      // route: see api/editor-routes.ts.
      path: 'videos',
      component: () => import('./admin/components/VideoEditorWorkspace'),
      requiredFeature: 'videos.edit',
      guard: 'none',
    },
  ],

  adminNavItems: [
    {
      path: '/videos',
      label: 'Videos',
      // Resolved from heroicons by stripping the Icon suffix, so this is
      // FilmIcon. An unknown name throws at render rather than falling back.
      icon: 'Film',
      requiredFeature: 'videos.edit',
      defaultSection: 'Content',
      defaultLocation: 'sidebar',
      // conference-recap is 63 and vehicle-video 64; this sits with them.
      order: 65,
    },
  ],

  workers: [
    {
      // File stem must equal the job-name suffix: the prod worker derives the
      // job name from the handler filename as `${moduleId}:${stem}`.
      name: 'videos:publish-due',
      handler: './workers/publish-due.ts',
      concurrency: 1,
    },
    {
      name: 'videos:reap-upload-sessions',
      handler: './workers/reap-upload-sessions.ts',
      concurrency: 1,
    },
    {
      name: 'videos:import-from-youtube',
      handler: './workers/import-from-youtube.ts',
      // One video at a time. Each one streams a whole file through the worker,
      // so concurrency here would multiply both memory and egress.
      concurrency: 1,
    },
  ],

  crons: [
    {
      // Every minute. A publication scheduled for 09:00 should go out at
      // 09:00, and the handler is a no-op when nothing is due.
      name: 'videos:publish-due',
      queue: 'jobs',
      schedule: { pattern: '* * * * *' },
      data: { kind: 'videos:publish-due' },
    },
    {
      // Quarter-hourly. An abandoned upload holds a master slot and costs
      // storage, so it should not sit for a day.
      name: 'videos:reap-upload-sessions',
      queue: 'jobs',
      schedule: { pattern: '*/15 * * * *' },
      data: { kind: 'videos:reap-upload-sessions' },
    },
  ],

  configSchema: {
    youtube_import_max_bytes: {
      key: 'youtube_import_max_bytes',
      type: 'number',
      required: false,
      default: '2147483648',
      label: 'Largest video to pull down from YouTube (bytes)',
      description:
        'Per-video ceiling for the YouTube import. A conference is 50 to 60 talks, so this '
        + 'multiplied by the talk count is the storage a single import will consume.',
    },
    youtube_import_run_cap_bytes: {
      key: 'youtube_import_run_cap_bytes',
      type: 'number',
      required: false,
      default: '32212254720',
      label: 'Total budget per import run (bytes)',
      description:
        'The run stops once it has pulled this much, so an import cannot quietly consume '
        + 'tens of gigabytes. Defaults to 30 GB, about one conference.',
    },
  },

  onInstall: async () => {
    console.log('[videos] Module installed');
  },
  onEnable: async () => {
    console.log('[videos] Module enabled — registered as content type "video".');
  },
};

export default videosModule;
