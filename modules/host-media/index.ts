/**
 * Host-media module — shared media management for sites/events/
 * newsletters/blog/podcasts. Owns the host_media table, API routes,
 * admin tab, upload pipeline (Sharp/YouTube/ZIP/chunked), reference
 * tracking, quotas. Consumer modules opt in via the `hostMediaConsumer`
 * block in their own GatewazeModule manifest; the host-media admin
 * tab + API check the registry to enable/disable per-kind features.
 *
 * Per spec-host-media-module.md.
 */

import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

const hostMediaModule: GatewazeModule = {
  id: 'host-media',
  group: 'content',
  type: 'feature',
  visibility: 'public',
  name: 'Host Media',
  description:
    'Shared media management — table, API, admin tab, upload pipeline (Sharp variants, YouTube delegation, ZIP unpack, chunked upload), reference tracking, quotas. Consumed by sites/events/newsletters/blog/podcasts via the hostMediaConsumer registry block.',
  version: '0.4.0',

  features: [
    'host-media',
    'host-media.albums',
    'host-media.youtube',
    'host-media.zip-unpack',
    'host-media.chunked-upload',
  ],

  // No hard module dependencies. Soft dependency on the consumer
  // module's permission predicates (templates.can_admin_host for
  // sites/list/newsletter; can_admin_event/blog/podcast for the rest).
  dependencies: [],

  migrations: [
    'migrations/001_host_media.sql',
    'migrations/002_host_media_albums.sql',
    'migrations/004_host_media_zip_uploads.sql',
    'migrations/005_host_media_quotas.sql',
    'migrations/006_host_media_used_in_rpcs.sql',
    'migrations/008_host_media_rls_dispatch.sql',
    'migrations/009_host_media_signed_url_log.sql',
    'migrations/010_host_media_chunked_uploads.sql',
    'migrations/011_host_media_sync_refs_fn.sql',
    'migrations/012_host_media_event_public_feed_index.sql',
    'migrations/013_host_media_public_read_approved_realtime.sql',
    'migrations/014_host_media_organizer.sql',
    'migrations/015_host_media_read_without_templates.sql',
  ],

  // edgeFunctions: deferred (per spec-host-media-module §11.2). The image
  // and chunk fns still live in event-media and are still owned by it.
  //
  // The two YouTube ones are not coming back here. media-upload-youtube was
  // deleted (it authenticated nobody), and media-process-youtube-uploads was
  // never written at all, which is why the youtube-poll cron that waited for
  // it only ever flipped rows to 'processing' and logged a TODO. Publishing
  // belongs to `videos-publisher-youtube` instead, per
  // spec-videos-publishing-and-platform-metrics.
  // edgeFunctions: [
  //   'media-process-image',
  //   'media-process-zip',
  //   'media-combine-chunks',
  // ],

  workers: [
    {
      name: 'host-media:used-in-rebuild',
      handler: './workers/used-in-rebuild-cron.ts',
    },
    {
      name: 'host-media:chunked-cleanup',
      handler: './workers/chunked-cleanup-cron.ts',
    },
  ],

  crons: [
    // Rebuild used_in from scratch nightly (belt-and-braces against
    // trigger drift).
    {
      name: 'host-media:used-in-rebuild',
      cron: '0 3 * * *',
      data: { kind: 'host-media:used-in-rebuild' },
    },
    // Reap expired chunked-upload sessions every hour.
    {
      name: 'host-media:chunked-cleanup',
      cron: '0 * * * *',
      data: { kind: 'host-media:chunked-cleanup' },
    },
  ],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    registerRoutes(app as never, context);
  },

  // The polymorphic admin tab is registered as a slot consumer modules
  // mount via their own adminRoutes / slot registrations. host-media
  // itself does not own a top-level admin nav entry — the tab lives
  // inside the consumer's detail page (Site / Event / Newsletter /
  // Blog / Podcast).
  adminSlots: [
    {
      slotName: 'host-media:tab',
      component: () => import('./admin/components/HostMediaTab.js'),
      order: 100,
    },
  ],

  onEnable: async (ctx) => {
    ctx?.logger.info('host-media module enabled');
  },
};

export default hostMediaModule;
export { hostMediaModule };
