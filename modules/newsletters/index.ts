import type { GatewazeModule } from '@gatewaze/shared';

const newslettersModule: GatewazeModule = {
  id: 'newsletters',
  group: 'content',
  type: 'feature',
  visibility: 'public',
  name: 'Newsletters',
  description: 'Create, edit, and distribute newsletters with edition management and subscriber tracking',
  version: '1.0.0',
  features: [
    'newsletters',
    'newsletters.editor',
    'newsletters.editions',
    'newsletters.subscribers',
    'newsletters.templates',
    'newsletters.sending',
  ],

  edgeFunctions: [
    // newsletter-send was deleted — the worker's dispatch-scheduled cron now
    // calls fanout_newsletter_send_recipients directly and the shared
    // SendingPanel routes immediate sends through the same scheduled path
    // (status='scheduled', scheduled_at=now), so there is no remaining
    // Deno-side responsibility for the newsletter send pipeline.
    'newsletter-signup',
    'newsletter-unsubscribe',
    'newsletter-gdoc-import',
    'email-inbound-parse',
    // Outbound admin replies (shared by broadcasts + newsletters, like
    // email-inbound-parse). Sends FROM the original send address; verifies the
    // caller is an active admin.
    'reply-send',
    'helix-task-create',
    'helix-task-embed-url',
    'newsletter-helix-output-sync',
  ],

  workers: [
    {
      name: 'newsletters:helix-output-sync',
      handler: './workers/helix-output-sync.ts',
    },
    {
      // Re-resolves click interactions stored with a NULL edition_link_id
      // (late-registered links / webhook redeliveries). Idempotent.
      name: 'newsletters:link-reconcile',
      handler: './workers/link-reconciler.ts',
    },
    {
      // Heartbeat that dispatches due scheduled sends (status='scheduled',
      // scheduled_at <= now): fans out into newsletter_send_recipients and
      // flips the send to 'sending', then runs a drip tick. BullMQ-driven
      // stand-in for pg_cron so scheduled sends fire on every deploy target
      // without that extension.
      name: 'newsletters:dispatch-scheduled',
      handler: './workers/dispatch-scheduled.ts',
    },
    {
      // Weekly list hygiene: suppress repeat-bouncers + inactive subscribers.
      // Report-only unless LIST_HYGIENE_ENABLED=true (see workers/list-hygiene.ts).
      name: 'newsletters:list-hygiene',
      handler: './workers/list-hygiene.ts',
    },
    {
      // Caches expensive per-edition stats RPCs (engagement, block_effectiveness)
      // for editions stable >NEWSLETTERS_SNAPSHOT_MIN_AGE_DAYS (default 30).
      // The wrappers in migration 061 read snapshots transparently, so the
      // stats page loads in O(N_snapshot_lookups) instead of O(N_send_logs).
      name: 'newsletters:edition-snapshot',
      handler: './workers/edition-snapshot.ts',
    },
  ],

  crons: [
    {
      name: 'newsletter-helix-output-sync',
      queue: 'jobs',
      schedule: { every: 60_000 },
      data: { kind: 'newsletters:helix-output-sync' },
    },
    {
      // Per spec-content-modules-git-architecture §15.4: snapshot editions
      // <snapshot_delay_days> days post-send. Job is idempotent; running
      // every 5 min picks up due editions promptly without spam.
      name: 'newsletter-edition-snapshot',
      queue: 'jobs',
      schedule: { every: 5 * 60_000 },
      data: { kind: 'newsletters:edition-snapshot' },
    },
    {
      // Back-fill block resolution for clicks that landed before their
      // registry row existed (spec-newsletter-link-tracking.md §8). Cheap +
      // idempotent; every 6h keeps the unresolved backlog small.
      name: 'newsletter-link-reconcile',
      queue: 'jobs',
      schedule: { every: 6 * 60 * 60_000 },
      data: { kind: 'newsletters:link-reconcile' },
    },
    {
      // Fire due scheduled sends every minute (see workers/dispatch-scheduled.ts).
      name: 'newsletter-dispatch-scheduled',
      queue: 'jobs',
      schedule: { every: 60_000 },
      data: { kind: 'newsletters:dispatch-scheduled' },
    },
    {
      // Weekly list hygiene (report-only until LIST_HYGIENE_ENABLED=true).
      name: 'newsletter-list-hygiene',
      queue: 'jobs',
      schedule: { every: 7 * 24 * 60 * 60_000 },
      data: { kind: 'newsletters:list-hygiene' },
    },
  ],

  dependencies: ['content-platform'],

  migrations: [
    'migrations/001_newsletters_tables.sql',
    'migrations/002_template_collections_and_sends.sql',
    'migrations/003_brick_block_association.sql',
    'migrations/004_content_category.sql',
    'migrations/005_ai_summary_block.sql',
    'migrations/006_newsletter_types.sql',
    'migrations/007_edition_block_template_fk.sql',
    'migrations/008_add_sort_order_columns.sql',
    'migrations/009_collection_accent_category.sql',
    'migrations/010_setup_complete.sql',
    'migrations/011_require_login.sql',
    'migrations/012_gdoc_import.sql',
    'migrations/013_portal_anon_rls.sql',
    'migrations/014_require_login_rls.sql',
    'migrations/015_replies.sql',
    'migrations/016_triage_adapter.sql',
    'migrations/017_keyword_adapter.sql',
    'migrations/018_register_with_platform.sql',
    'migrations/019_edition_blocks_realtime.sql',
    // Templates module cutover (per spec-templates-module §8):
    //   020 — add FK columns from edition_blocks → templates_*_defs
    //   021 — copy legacy block/brick templates into templates_* tables
    //   023 — drop legacy template tables (with pre-flight assertion)
    // Migration 022 (.disabled) is the prior manual-checklist version and
    // has been superseded by 023's in-SQL pre-flight DO block.
    'migrations/020_link_to_templates_module.sql',
    'migrations/021_copy_to_templates_module.sql',
    'migrations/023_drop_legacy_template_tables.sql',
    'migrations/024_editions_snapshot_columns.sql',
    'migrations/025_register_category_adapter.sql',
    'migrations/026_fix_keyword_trigger_definer.sql',
    'migrations/027_collection_git_provenance.sql',
    'migrations/028_enable_host_registration.sql',
    // 029 provides can_admin_newsletter(uuid) and re-points the host
    // registration at it. Without it, templates.can_read_host resolves
    // can_admin_fn as <fn>(uuid), fails to find is_admin(uuid), and returns
    // FALSE for everyone — so the templates_libraries insert during
    // newsletter creation 403s even for admins. 028 (host enable) is
    // incomplete without it.
    'migrations/029_can_admin_newsletter_uuid.sql',
    // 030 adds the config/git_url_theme columns for the separate theme +
    // publish repo layout (additive; the only DROP COLUMNs are in a
    // commented-out down-migration reference).
    'migrations/030_separate_publish_repo.sql',
    'migrations/031_realtime_sends_and_log.sql',
    // 032 repurposes newsletters_edition_links as the per-occurrence link
    // registry (opaque tracking_key) for block-level click tracking, and adds
    // tracking_slug to edition blocks. See spec-newsletter-link-tracking.md.
    'migrations/032_link_tracking.sql',
    'migrations/033_view_online_target.sql',
    'migrations/034_anon_read_edition_bricks.sql',
    // 035 adds delivery_strategy + the newsletter_send_recipients per-recipient
    // timing queue for tz-local / personalised delivery
    // (spec-newsletter-personalised-delivery.md Part A).
    'migrations/035_personalised_delivery.sql',
    // 035a adds the per-recipient CIO engagement profile that 036+038
    // both depend on — must apply before either of those. Named with
    // an alpha suffix so it sorts between 035 and 036 in a strict
    // alphanumeric apply order, without re-numbering the others.
    'migrations/035a_cio_recipient_engagement.sql',
    // 036 adds the newsletter_edition_engagement() aggregate RPC powering the
    // editions table's open/click + bot-filter columns. Uses 035a.
    'migrations/036_edition_engagement_rpc.sql',
    // 037/038 add the multi-source bot-detection comparison + cross-edition
    // click-corroboration RPCs (spec §6, Part C). 038 uses 035a.
    'migrations/037_detection_comparison_rpc.sql',
    'migrations/038_corroborated_engagement_rpc.sql',
    // 039 fixes a publish-blocker: the 001 FK on edition_links.block_id was
    // ON DELETE SET NULL while 032 made block_id NOT NULL — any delete-then-
    // reinsert save path bombed with 23502. Switches the FK to ON DELETE
    // CASCADE so tracking rows die with their block.
    'migrations/039_edition_links_fk_cascade.sql',
    'migrations/040_fanout_newsletter_send_recipients.sql',
    'migrations/041_send_recipient_timezone_breakdown.sql',
    'migrations/042_signup_forms_integration.sql',
    'migrations/043_send_status_cancelling.sql',
    'migrations/044_pause_and_exclude_sent.sql',
    // 045 floors human_opens at human_clicks in newsletter_edition_engagement.
    // Every human click implies a human open, so the dashboard's open count
    // must never fall below the click count — fixes the unscored estimate
    // path returning 0 opens on small sends despite a measured human click.
    'migrations/045_engagement_human_opens_floor.sql',
    // 046 makes fanout_newsletter_send_recipients survive a 56k+ list:
    // adds idx_people_lower_email so the LATERAL person lookup is an index
    // probe instead of a seq scan, and bumps the function's statement_timeout
    // to 10min so a one-off slow fan-out doesn't lapse the default 25s.
    'migrations/046_fanout_large_list_perf.sql',
    // 047 fixes the exclude-already-sent filter on both the JS-side
    // exclusion (immediate global) and the SQL-side exclusion (fanout
    // for tz_local / personalised): match sent_at IS NOT NULL, not
    // status='sent' — the lifecycle moves past 'sent' to 'delivered'
    // etc. and the exclude window slipped, double-sending everyone.
    'migrations/047_fanout_exclude_uses_sent_at.sql',
    // 048 adds is_auto_reply + auto_reply_reason to newsletter_replies so
    // OOOs / vacation responders / bounces detected by email-inbound-parse
    // are hidden by default in the admin replies tab (toggle to show).
    'migrations/048_replies_auto_reply_flag.sql',
    'migrations/045_list_hygiene.sql',
    'migrations/049_geo_engagement_config_and_indexes.sql',
    'migrations/050_geo_engagement_rpcs.sql',
    'migrations/051_geo_rollup_mv.sql',
    'migrations/052_block_effectiveness_rpc.sql',
    'migrations/053_poll_results_rpc.sql',
    // 053 Central Sending Service foundation (newsletter domain): send batches +
    // batch_id + watchdog index + brand/channel (spec-central-sending-service.md).
    'migrations/053_send_engine_batches.sql',
    // 054 fanout produces send_at=now() for the 'global' strategy, so immediate
    // "send to everyone now" rides the worker drip engine (the legacy edge
    // processSend loop has been removed).
    'migrations/054_fanout_global_send_now.sql',
    // 055 recipient-count preview RPC for the sending UI indicator.
    'migrations/055_recipient_preview_count.sql',
    // 056 makes signals-v1 (or any active bot detector) show up in the
    // admin UI's "Detection sources" card by widening edition_detection_
    // comparison to UNION from email_interactions (where the SendGrid
    // webhook writes scored per-event records). Prior RPC only saw the
    // email_events stream (CIO import + pixel/redirect), so webhook-
    // scored signals were invisible. Found on AAIF prod 2026-06-23.
    'migrations/056_detection_comparison_with_interactions.sql',
    // 057 makes the "Unsubscribed" metric on the edition card actually
    // count opt-outs. Prior version (in 045) read email_send_log.
    // unsubscribed_at — but nothing writes to that column; the canonical
    // opt-out path updates list_subscriptions. So the metric was always
    // 0. Now sourced from list_subscriptions, scoped to the send's
    // list_ids + started_at. Adds idx_list_subscriptions_lower_email
    // partial index so the per-edition lookup stays under the 25s
    // statement_timeout. Found on AAIF prod 2026-06-24.
    'migrations/057_engagement_unsubscribed_from_list_subscriptions.sql',
    'migrations/058_engagement_read_webhook_stream.sql',
    // 058 seeds the email_only_intro block-def in every email library —
    // a clone of intro_paragraph that the portal /View Online/ page
    // filters out (blocks whose block_type starts with `email_only_`).
    // Use case: apology / correction headers on a re-send that should
    // not appear in the public archive. Paired with EmailOnlyIntro.tsx
    // (admin component) + the portal filter in [edition].tsx.
    'migrations/058_email_only_intro_block_def.sql',
    // 059 attaches statement_timeout=10min to the fanout fn via
    // ALTER FUNCTION ... SET. The earlier `SET LOCAL` inside the body
    // doesn't extend the timer for the outer PostgREST call, so 50k+
    // lists trip the role-level timeout before the body completes.
    // Surfaced on AAIF MLOps Community (55,437 subs) 2026-06-25.
    'migrations/059_fanout_set_statement_timeout_proconfig.sql',
    // 060 raises the engagement RPC's per-function statement_timeout
    // from 25s to 5min. Surfaced on AAIF/MLOps when a 55k send landed
    // and the multi-CTE aggregate cold-cache run tripped 25s. Cache /
    // snapshot pattern is the longer-term answer; this just stops the
    // stats tab from 500'ing.
    'migrations/060_engagement_rpc_timeout_to_5min.sql',
    // 061 stands up a per-edition snapshot cache for the heavy stats RPCs
    // (engagement, block_effectiveness). Existing RPCs get renamed to *_live
    // and re-wrapped with snapshot-aware versions that merge cached + live
    // rows per edition. Worker `newsletters:edition-snapshot` populates
    // snapshots for editions stable >30 days.
    'migrations/061_edition_stats_snapshots.sql',
    // 062 drops the legacy `link_type` column reference from
    // newsletter_poll_results. 053 was authored against the pre-link-
    // tracking-rebuild schema and silently 500'd on the Stats > Blocks
    // panel for every install whose table no longer carried the column.
    'migrations/062_poll_results_drop_link_type_ref.sql',
    // 063 extends the migration-061 snapshot cache to the geo RPCs
    // (geo_engagement, local_time_engagement, block_geo,
    // engagement_timeline) + poll_results. Each existing RPC gets
    // renamed to *_live and replaced by a snapshot-aware wrapper that
    // checks the snapshot table first and lazily populates a snapshot
    // when called for a stable edition. newsletter_refresh_edition_snapshots
    // is extended to pre-warm the common geo combos
    // (country-level, open/click metrics).
    'migrations/063_geo_rpcs_snapshot_wrappers.sql',
    // 064 records outbound admin replies (the "reply to a reply" composer).
    'migrations/064_newsletter_reply_messages.sql',
    // 065 adds star/archive triage status to newsletter replies.
    'migrations/065_newsletter_reply_status.sql',
  ],

  // Hook to register newsletters as a host-media consumer at apiRoutes
  // load time. Newsletters didn't previously expose any API routes;
  // this hook does nothing else. The DB-side dispatch fn already
  // includes a `newsletter` branch (host-media migration 008).
  apiRoutes: async (app, context) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { registerHostMediaConsumer } = await import('../host-media/lib/registry.js' as any);
    registerHostMediaConsumer({
      hostKind: 'newsletter',
      enableAlbums: false,
      enableSponsorTagging: false,
      enableYouTube: false,
      enableZipUnpack: false,
      contentTables: [
        // Edition body content references media via embedded HTML/jsonb.
        {
          table: 'newsletters_editions',
          staticHostKind: 'newsletter',
          hostIdColumn: 'newsletter_id',
          contentColumn: 'content',
          consumerType: 'edition',
          idColumn: 'id',
          nameColumn: 'subject',
        },
      ],
    });

    // Edition publish-to-git + collection init/graduate/drift/manifest/
    // delete endpoints. The earlier draft of this hook expected the
    // api server to expose `context.deps.{supabase, gitServer,
    // requireJwt}` and silently no-op'd when those weren't present —
    // which was always: the api server's runtime context exposes
    // `supabase: null` and no `deps` block at all.
    //
    // Mirrors host-media's pattern: own supabase client built from
    // env vars, own requireJwt middleware, own Router mounted at
    // /api/admin. See modules/newsletters/api/register-routes.ts.
    try {
      const { registerRoutes } = await import('./api/register-routes.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await registerRoutes(app as any, context);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[newsletters] publish-to-git route registration failed:', err);
    }
  },

  adminRoutes: [
    // Newsletter list & creation
    { path: 'newsletters', component: () => import('./admin/pages/list'), requiredFeature: 'newsletters', guard: 'none' },
    { path: 'newsletters/new', component: () => import('./admin/components/NewsletterSetupWizard'), requiredFeature: 'newsletters', guard: 'none' },

    // Newsletter detail (hero + tabs: details, template, editions, stats)
    { path: 'newsletters/:slug', component: () => import('./admin/pages/detail'), requiredFeature: 'newsletters', guard: 'none' },
    { path: 'newsletters/:slug/:tab', component: () => import('./admin/pages/detail'), requiredFeature: 'newsletters', guard: 'none' },

    // Edition editor (within a newsletter)
    { path: 'newsletters/:slug/editions/:id', component: () => import('./admin/pages/editions/[id]'), requiredFeature: 'newsletters', guard: 'none' },
    { path: 'newsletters/:slug/editions/:id/:tab', component: () => import('./admin/pages/editions/[id]'), requiredFeature: 'newsletters', guard: 'none' },

    // Legacy edition editor routes (backward compatibility)
    { path: 'newsletters/editor/:id', component: () => import('./admin/pages/editions/[id]'), requiredFeature: 'newsletters', guard: 'none' },
    { path: 'newsletters/editor/:id/:tab', component: () => import('./admin/pages/editions/[id]'), requiredFeature: 'newsletters', guard: 'none' },

    // Template management (still accessible directly for power users)
    { path: 'newsletters/templates', component: () => import('./admin/pages/templates/index'), requiredFeature: 'newsletters.templates', guard: 'none' },
    { path: 'newsletters/templates/:collectionSlug', component: () => import('./admin/pages/templates/[collectionSlug]'), requiredFeature: 'newsletters.templates', guard: 'none' },
    { path: 'newsletters/templates/:collectionSlug/blocks/:blockType', component: () => import('./admin/pages/templates/block-editor'), requiredFeature: 'newsletters.templates', guard: 'none' },
    { path: 'newsletters/templates/:collectionSlug/bricks/:brickType', component: () => import('./admin/pages/templates/brick-editor'), requiredFeature: 'newsletters.templates', guard: 'none' },
    { path: 'newsletters/templates/:collectionSlug/upload', component: () => import('./admin/pages/templates/upload'), requiredFeature: 'newsletters.templates', guard: 'none' },

    // Send management
    { path: 'newsletters/sends', component: () => import('./admin/pages/sends/index'), requiredFeature: 'newsletters.sending', guard: 'none' },
    { path: 'newsletters/sends/:id', component: () => import('./admin/pages/sends/[id]'), requiredFeature: 'newsletters.sending', guard: 'none' },
  ],
  adminNavItems: [
    { path: '/newsletters', label: 'Newsletters', icon: 'Newspaper', requiredFeature: 'newsletters', defaultSection: 'Content', defaultLocation: 'sidebar', order: 10 },
  ],

  portalNav: {
    label: 'Newsletters',
    path: '/newsletters',
    icon: 'newspaper',
    order: 30,
  },
  // Workspace-shell rail item (spec-portal-workspace-shell.md §8). Public top-level module.
  portalShell: {
    rail: { label: 'News', full: 'Newsletters', icon: 'newspaper', order: 30, visibility: 'public' },
    nav: [],
    publicNav: [],
  },

  portalRoutes: [
    { path: '/newsletters', component: () => import('./portal/pages/index') },
    // Canonical edition URL: /newsletters/<collection>/<date-subject-slug>
    { path: '/newsletters/:collection/:edition', component: () => import('./portal/pages/[collection]/[edition]') },
    // Per-newsletter page; also absorbs the legacy /newsletters/<slug>--<date> redirect.
    { path: '/newsletters/:collection', component: () => import('./portal/pages/[collection]/index') },
  ],

  publicApiScopes: [
    { action: 'read', description: 'Read published newsletter editions and types' },
  ],

  publicApiRoutes: async (router: unknown, ctx: any) => {
    const { registerPublicApi } = await import('./public-api');
    registerPublicApi(router, ctx);
  },

  publicApiSchema: {
    tag: { name: 'Newsletters', description: 'Newsletter types and published editions' },
    paths: {
      '/': {
        get: {
          summary: 'List newsletter types',
          operationId: 'listNewsletters',
          parameters: [
            { name: 'content_category', in: 'query', schema: { type: 'string' }, description: 'Filter by category slug (comma-separated for multiple)' },
            { name: 'fields', in: 'query', schema: { type: 'string' }, description: 'Comma-separated field allowlist' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, minimum: 1, maximum: 100 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 } },
          ],
          responses: { 200: { description: 'List of newsletter types' } },
        },
      },
      '/{slug}': {
        get: {
          summary: 'Get a newsletter type by slug',
          operationId: 'getNewsletter',
          parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Newsletter type' }, 404: { $ref: '#/components/responses/NotFound' } },
        },
      },
      '/{slug}/editions': {
        get: {
          summary: 'List published editions for a newsletter type',
          operationId: 'listNewsletterEditions',
          parameters: [
            { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Editions on or after this date' },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Editions on or before this date' },
            { name: 'content_category', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 100 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          ],
          responses: { 200: { description: 'Published editions' } },
        },
      },
      '/editions/{id}': {
        get: {
          summary: 'Get a single edition by ID',
          operationId: 'getNewsletterEdition',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Edition metadata' }, 404: { $ref: '#/components/responses/NotFound' } },
        },
      },
      '/editions/{id}/content': {
        get: {
          summary: 'Get full block + brick content for an edition',
          operationId: 'getNewsletterEditionContent',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Edition content with ordered blocks and bricks' } },
        },
      },
    },
  },

  publicContentSources: [
    {
      type: 'newsletter_edition',
      table: 'newsletters_editions',
      scope: 'newsletters:read',
      fields: { id: 'id', title: 'title', date: 'edition_date', summary: 'preheader' },
      visibilityFilter: [{ column: 'status', eq: 'published' }],
      resourcePath: (row) => `/newsletters/editions/${row.id}`,
      // Mirrors PUBLIC_EDITION_FIELDS in public-api.ts.
      fullFields: [
        'id', 'title', 'edition_date', 'preheader', 'content_category',
        'collection_id', 'created_at', 'updated_at',
      ],
    },
  ],

  configSchema: {
    GOOGLE_CLIENT_ID: {
      key: 'GOOGLE_CLIENT_ID',
      type: 'string',
      required: false,
      description: 'Google OAuth client ID for Google Docs import (shared with google-sheets module if installed)',
    },
    GOOGLE_CLIENT_SECRET: {
      key: 'GOOGLE_CLIENT_SECRET',
      type: 'secret',
      required: false,
      description: 'Google OAuth client secret',
    },
    GOOGLE_REFRESH_TOKEN: {
      key: 'GOOGLE_REFRESH_TOKEN',
      type: 'secret',
      required: false,
      description: 'Google OAuth refresh token with Docs and Drive read scopes',
    },
    ANTHROPIC_API_KEY: {
      key: 'ANTHROPIC_API_KEY',
      type: 'secret',
      required: false,
      description: 'Claude API key for AI-powered Google Doc section mapping during import',
    },
    HELIX_URL: {
      key: 'HELIX_URL',
      type: 'secret',
      required: false,
      description: 'Helix instance URL for AI content research (e.g. https://meta.helix.ml). Marked secret so resolveModuleSecrets syncs it into the Supabase project secrets table — helix-task-create reads it via Deno.env.get() at edge-function runtime.',
    },
    HELIX_API_KEY: {
      key: 'HELIX_API_KEY',
      type: 'secret',
      required: false,
      description: 'Helix API key for creating research tasks',
    },
    HELIX_PROJECT_ID: {
      key: 'HELIX_PROJECT_ID',
      type: 'secret',
      required: false,
      description: 'Helix project ID for research tasks. Marked secret so the edge function can read it via Deno.env.get().',
    },
    HELIX_ORG_SLUG: {
      key: 'HELIX_ORG_SLUG',
      type: 'secret',
      required: false,
      description: 'Helix organization slug for building task URLs (e.g. "helix"). Marked secret so the edge function can read it via Deno.env.get().',
    },
  },

  onInstall: async () => {
    console.log('[newsletters] Module installed');
  },

  onEnable: async () => {
    console.log('[newsletters] Module enabled');
  },

  onDisable: async () => {
    console.log('[newsletters] Module disabled');
  },
};

export default newslettersModule;
