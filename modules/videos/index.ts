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
  version: '1.12.0',
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
    // 010 adopts a connected account's whole back catalogue, not only what
    // Gatewaze published, and gives videos belonging to no event or podcast
    // somewhere to wait. Unassigned is the ABSENCE of a video_subjects row.
    'migrations/010_video_discovery.sql',
    // 011 adds followers per account over time, and the cross-platform
    // rollups: one video across platforms, one episode or talk, one event.
    'migrations/011_audience_and_rollups.sql',
    // 012 gives a connection non-secret settings (a feed URL, an OP3 show
    // uuid), with a CHECK that refuses anything that looks like a token.
    'migrations/012_connection_config.sql',
    // 013 lets a video belong to a whole podcast. assign_video_subject() has
    // accepted 'podcast' since 010 while the table's CHECK rejected it, so
    // the function accepted the value and the INSERT then failed.
    'migrations/013_podcast_subject.sql',
    // 014 records which storage API holds each asset, so masters can live in
    // an S3-compatible bucket (Backblaze B2 on AAIF) while thumbnails and
    // every earlier row stay on Supabase Storage.
    'migrations/014_storage_provider.sql',
    // 015 names a master adopted from an object that was put in the bucket
    // by something outside the module (a local yt-dlp run shipped up).
    'migrations/015_bucket_import_source.sql',
    // 016 adds the studio pass: one row per video holding what the worker
    // found in the master, the headline drafts, the editor's choices and
    // what approval produced.
    'migrations/016_studio.sql',
    // 017 adds upload batches: a prefix in the master bucket plus an
    // expiring, upload-only Backblaze key issued to one person, with a cron
    // that adopts what lands there.
    'migrations/017_upload_batches.sql',
    // 018 keeps the uploaded object's path on the master that was copied
    // from it, because the adopted master lives outside the batch prefix.
    'migrations/018_batch_import_path.sql',
    // 019 records key revocation so a failed delete is retried, and makes
    // each uploaded object adopt exactly once.
    'migrations/019_batch_revoke_and_dedupe.sql',
    // 020 adds a company logo per talk (not per speaker) and the studio's
    // own uploads: a speaker photo or a background image in place of a frame.
    'migrations/020_talk_logos_and_uploads.sql',
  ],

  apiRoutes: async (app: unknown, ctx?: unknown) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- express/ctx shapes are host-provided
    registerRoutes(app as any, ctx as any);
  },

  adminRoutes: [
    {
      // The studio for one video: cut-outs, headline, trim, pre-roll, approve.
      path: 'videos/studio/:videoId',
      component: () => import('./admin/components/VideoStudio'),
      requiredFeature: 'videos.edit',
      guard: 'none',
    },
    {
      path: 'videos/batches/:batchId',
      component: () => import('./admin/components/VideoBatchDetail'),
      requiredFeature: 'videos.manage',
      guard: 'none',
    },
    {
      path: 'videos/batches',
      component: () => import('./admin/components/VideoBatches'),
      requiredFeature: 'videos.manage',
      guard: 'none',
    },
    {
      // Before 'videos', so a future 'videos/:id' cannot swallow it.
      path: 'videos/unassigned',
      component: () => import('./admin/components/UnassignedVideos'),
      requiredFeature: 'videos.edit',
      guard: 'none',
    },
    {
      path: 'videos/imports',
      component: () => import('./admin/components/VideoImports'),
      requiredFeature: 'videos.manage',
      guard: 'none',
    },
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
    {
      path: '/videos/unassigned',
      label: 'Unassigned videos',
      // InboxStackIcon.
      icon: 'InboxStack',
      requiredFeature: 'videos.edit',
      defaultSection: 'Content',
      defaultLocation: 'sidebar',
      order: 66,
    },
    {
      path: '/videos/imports',
      label: 'Video imports',
      // ArrowDownTrayIcon.
      icon: 'ArrowDownTray',
      requiredFeature: 'videos.manage',
      defaultSection: 'Content',
      defaultLocation: 'sidebar',
      order: 67,
    },
    {
      path: '/videos/batches',
      label: 'Upload batches',
      // FolderArrowDownIcon.
      icon: 'FolderArrowDown',
      requiredFeature: 'videos.manage',
      defaultSection: 'Content',
      defaultLocation: 'sidebar',
      order: 68,
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
    {
      name: 'videos:import-masters-from-drive',
      handler: './workers/import-masters-from-drive.ts',
      concurrency: 1,
    },
    {
      // Rows only, no bytes moved: adopts objects already in the S3 bucket.
      name: 'videos:adopt-from-bucket',
      handler: './workers/adopt-from-bucket.ts',
      concurrency: 1,
    },
    {
      // Downloads a master, samples it, calls the vision model, cuts the
      // speaker out. One at a time: each holds a master on disk and a
      // Chromium is not involved here but ffmpeg is, on every frame.
      name: 'videos:studio-analyse',
      handler: './workers/studio-analyse.ts',
      concurrency: 1,
    },
    {
      // Renders the thumbnail in Chromium and, when asked, cuts and joins
      // the master. One at a time for the same reason.
      name: 'videos:studio-finalize',
      handler: './workers/studio-finalize.ts',
      concurrency: 1,
    },
    {
      // Cuts an uploaded speaker photo out and adds it as a frame.
      name: 'videos:studio-upload',
      handler: './workers/studio-upload.ts',
      concurrency: 1,
    },
    {
      // Lists each open batch's prefix and adopts what landed. Rows only.
      name: 'videos:sync-batches',
      handler: './workers/sync-batches.ts',
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
    {
      // Every five minutes. A listing per open batch is one cheap call, and
      // an editor watching the batch page should see a file within minutes
      // of it landing. A no-op with no open batch.
      name: 'videos:sync-batches',
      queue: 'jobs',
      schedule: { pattern: '*/5 * * * *' },
      data: { kind: 'videos:sync-batches' },
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
    studio_max_master_bytes: {
      key: 'studio_max_master_bytes',
      type: 'number',
      required: false,
      default: '8589934592',
      label: 'Largest master the studio will analyse (bytes)',
      description:
        'The studio copies the master to the worker\'s disk to sample and cut it. Defaults to 8 GB; '
        + 'a multi-hour livestream above this is refused with a message rather than filling the pod.',
    },
    batch_max_files: {
      key: 'batch_max_files',
      type: 'number',
      required: false,
      default: '200',
      label: 'Most files one upload batch will adopt',
      description:
        'Every adopted file is a video row, a server-side copy and a studio pass with model calls. '
        + 'A batch past this many is flagged and stops adopting; close it and open another.',
    },
    studio_sample_every_seconds: {
      key: 'studio_sample_every_seconds',
      type: 'number',
      required: false,
      default: '10',
      label: 'Seconds between sampled frames',
      description:
        'How often the studio takes a frame to judge. Ten seconds is 100 frames for a 17-minute talk; '
        + 'the interval widens on its own so a long video never samples more than 300.',
    },
    drive_import_run_cap_bytes: {
      key: 'drive_import_run_cap_bytes',
      type: 'number',
      required: false,
      default: '322122547200',
      label: 'Total budget per Drive import run (bytes)',
      description:
        'The Takeout import stops once it has copied this much into the master store. '
        + 'Defaults to 300 GB, about one conference of original uploads. Re-run to continue.',
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
