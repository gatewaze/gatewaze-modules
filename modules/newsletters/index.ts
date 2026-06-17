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
    'newsletter-send',
    'newsletter-unsubscribe',
    'newsletter-gdoc-import',
    'email-inbound-parse',
    'helix-task-create',
    'helix-task-embed-url',
    'newsletter-helix-output-sync',
  ],

  workers: [
    {
      name: 'newsletter:helix-output-sync',
      handler: './workers/helix-output-sync.ts',
    },
    {
      // Re-resolves click interactions stored with a NULL edition_link_id
      // (late-registered links / webhook redeliveries). Idempotent.
      name: 'newsletter:link-reconcile',
      handler: './workers/link-reconciler.ts',
    },
    {
      // Heartbeat that dispatches due scheduled sends (status='scheduled',
      // scheduled_at <= now). Triggers the newsletter-send edge function's
      // process_scheduled path — the BullMQ-driven stand-in for pg_cron so
      // scheduled sends fire on every deploy target without that extension.
      name: 'newsletter:dispatch-scheduled',
      handler: './workers/dispatch-scheduled.ts',
    },
  ],

  crons: [
    {
      name: 'newsletter-helix-output-sync',
      queue: 'jobs',
      schedule: { every: 60_000 },
      data: { kind: 'newsletter:helix-output-sync' },
    },
    {
      // Per spec-content-modules-git-architecture §15.4: snapshot editions
      // <snapshot_delay_days> days post-send. Job is idempotent; running
      // every 5 min picks up due editions promptly without spam.
      name: 'newsletter-edition-snapshot',
      queue: 'jobs',
      schedule: { every: 5 * 60_000 },
      data: { kind: 'newsletter:edition-snapshot' },
    },
    {
      // Back-fill block resolution for clicks that landed before their
      // registry row existed (spec-newsletter-link-tracking.md §8). Cheap +
      // idempotent; every 6h keeps the unresolved backlog small.
      name: 'newsletter-link-reconcile',
      queue: 'jobs',
      schedule: { every: 6 * 60 * 60_000 },
      data: { kind: 'newsletter:link-reconcile' },
    },
    {
      // Fire due scheduled sends every minute (see workers/dispatch-scheduled.ts).
      name: 'newsletter-dispatch-scheduled',
      queue: 'jobs',
      schedule: { every: 60_000 },
      data: { kind: 'newsletter:dispatch-scheduled' },
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
    // Legacy /newsletters/<slug>--<date> → redirects to the canonical URL.
    { path: '/newsletters/:date', component: () => import('./portal/pages/_date') },
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
