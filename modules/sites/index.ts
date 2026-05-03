/**
 * Sites module — multi-site web builder.
 *
 * Pages, page composition, publishing (portal / k8s-internal / external),
 * custom domains, per-site media library, draft preview, Site Editor role.
 *
 * Authoring primitives (marker grammar, parser, source ingest, A/B engine,
 * version pinning) are owned by the templates module; this module consumes
 * them via @gatewaze-modules/templates.
 *
 * See spec-sites-module.md.
 */

import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

const sitesModule: GatewazeModule = {
  id: 'sites',
  type: 'feature',
  visibility: 'public',
  name: 'Sites',
  description:
    'Multi-site web builder. Pages, publishing (portal/k8s/external publishers), custom domains, per-site media library, draft preview. Consumes @gatewaze-modules/templates.',
  version: '0.1.0',

  features: [
    'sites',
    'sites.editor',
    'sites.publishing.portal',
    'sites.publishing.k8s',
    // External publisher features are contributed by sub-modules:
    //   sites.publishing.vercel, sites.publishing.netlify, sites.publishing.cloudflare
  ],

  // Hard dependency on the templates module — sites can't function without
  // a library to bind to and a parser to ingest sources.
  dependencies: ['templates'],

  migrations: [
    'migrations/001_sites_tables.sql',
    'migrations/002_pages_tables.sql',
    'migrations/003_sites_triggers.sql',
    'migrations/004_sites_fks_to_templates.sql',
    'migrations/005_sites_rls.sql',
    'migrations/006_sites_theme_kinds.sql',
    'migrations/007_sites_nextjs_tables.sql',
    'migrations/008_sites_writes_via_admin.sql',
    'migrations/009_register_site_host.sql',
    'migrations/010_rename_theme_kinds.sql',
    'migrations/011_seed_portal_site.sql',
    'migrations/012_pages_composition_mode.sql',
    'migrations/013_git_provenance.sql',
    'migrations/014_internal_repos.sql',
    'migrations/015_host_media.sql',
    'migrations/016_navigation_menus.sql',
    'migrations/017_auth_columns.sql',
    'migrations/018_compliance_columns.sql',
    'migrations/019_republish_log.sql',
    'migrations/020_boilerplate_versions.sql',
    'migrations/021_repo_advisory_lock.sql',
    'migrations/022_menu_replace_items_rpc.sql',
    'migrations/023_host_media_quota_decrement.sql',
    'migrations/024_host_media_usage_rpcs.sql',
    'migrations/025_media_reference_triggers.sql',
    'migrations/026_site_drift_state.sql',
    'migrations/027_signed_media_urls.sql',
    'migrations/028_mega_menus_and_segments.sql',
    'migrations/029_brand_assets_library.sql',
    'migrations/030_i18n_locales.sql',
  ],

  workers: [
    {
      // Routes data.kind=sites:boilerplate-version-poll to the GitHub-Releases poller.
      name: 'sites:boilerplate-version-poll',
      handler: './workers/cron-dispatchers.ts',
    },
    {
      name: 'sites:scheduled-republish',
      handler: './workers/cron-dispatchers.ts',
    },
    {
      name: 'sites:drift-watch',
      handler: './workers/cron-dispatchers.ts',
    },
    {
      name: 'sites:media-usage-reconcile',
      handler: './workers/cron-dispatchers.ts',
    },
  ],

  crons: [
    {
      // Per spec-content-modules-git-architecture §14.4: poll boilerplate
      // GitHub Releases every 6h and cache latest tag in
      // gatewaze_boilerplate_versions for the apply-theme UX.
      name: 'sites-boilerplate-version-poll',
      queue: 'jobs',
      schedule: { every: 6 * 60 * 60 * 1000 },
      data: { kind: 'sites:boilerplate-version-poll' },
    },
    {
      // Per spec §6.7: scheduled republish for sites with publish_schedule_cron set.
      // Job runs every minute; the worker checks each site's cron and triggers
      // due publishes. Per-site cadence is enforced by the cron expression.
      name: 'sites-scheduled-republish',
      queue: 'jobs',
      schedule: { every: 60_000 },
      data: { kind: 'sites:scheduled-republish' },
    },
    {
      // Per spec §6.4: drift watcher polls external git for `main` updates.
      // Default platform-wide cadence is 15 min; per-site cadence configurable
      // via sites.drift_watch_interval_ms (config TBD).
      name: 'sites-drift-watcher',
      queue: 'jobs',
      schedule: { every: 15 * 60_000 },
      data: { kind: 'sites:drift-watch' },
    },
    {
      // Per spec §18.4: nightly reconciliation backstop for host_media.used_in
      // — walks all content and rewrites used_in arrays from scratch. Drift
      // fires an alert.
      name: 'sites-media-usage-reconcile',
      queue: 'jobs',
      schedule: { every: 24 * 60 * 60 * 1000 },
      data: { kind: 'sites:media-usage-reconcile' },
    },
  ],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRoutes(app as any, context);
  },

  adminRoutes: [
    { path: 'sites', component: () => import('./admin/pages/index'), requiredFeature: 'sites', guard: 'none' },
    { path: 'sites/:siteSlug', component: () => import('./admin/pages/detail'), requiredFeature: 'sites', guard: 'none' },
    { path: 'sites/:siteSlug/:tab', component: () => import('./admin/pages/detail'), requiredFeature: 'sites', guard: 'none' },
    { path: 'sites/:siteSlug/pages/:pageId', component: () => import('./admin/pages/page-editor'), requiredFeature: 'sites', guard: 'none' },
  ],

  adminNavItems: [
    {
      path: '/sites',
      label: 'Sites',
      icon: 'Globe',
      requiredFeature: 'sites',
      parentGroup: 'dashboards',
      order: 16,
    },
  ],

  configSchema: {
    publisher_build_dir: {
      key: 'publisher_build_dir',
      type: 'string',
      label: 'Publisher build directory',
      required: false,
      default: '/data/publisher-builds',
      description: 'Container-visible path for ephemeral build artifacts. PVC-backed in k8s.',
    },
    sites_scratch_dir: {
      key: 'sites_scratch_dir',
      type: 'string',
      label: 'Sites scratch directory',
      required: false,
      default: '/tmp/sites-scratch',
      description: 'Per-request scratch space for renderer / preview operations.',
    },
    build_concurrency: {
      key: 'build_concurrency',
      type: 'number',
      label: 'Publisher worker build concurrency',
      required: false,
      default: '2',
      description: 'How many sites can build in parallel. Tune for available worker CPU.',
      min: 1,
      max: 16,
    },
    build_timeout_ms: {
      key: 'build_timeout_ms',
      type: 'number',
      label: 'Publisher build timeout (ms)',
      required: false,
      default: '300000',
      description: 'Per-build hard timeout. Workers self-abort and the row goes to status=failed.',
      min: 60_000,
      max: 30 * 60 * 1000,
    },
    build_node_heap_mb: {
      key: 'build_node_heap_mb',
      type: 'number',
      label: 'Build subprocess Node heap (MB)',
      required: false,
      default: '512',
      description: 'Each spawned build subprocess runs with --max-old-space-size set to this value.',
      min: 128,
      max: 8192,
    },
    egress_allowlist: {
      key: 'egress_allowlist',
      type: 'string',
      label: 'Egress allowlist (CSV)',
      required: false,
      default: '',
      description:
        'When non-empty, restricts external-publisher API egress to listed hostnames (comma-separated).',
    },
  },

  onInstall: async () => {
    console.log('[sites] Module installed (v0.1.0)');
  },

  onEnable: async () => {
    console.log('[sites] Module enabled — registering site / portal page-host kinds');
    // Host registration happens via SQL seed in a follow-up migration once
    // a target Supabase exists; the manifest hook can't run DDL.

    // Register the TSX marker parser with the templates module's parser
    // registry — extension point per spec §8.2 + parser-registry.ts.
    // Wrapped in try so a missing templates module doesn't block enable.
    try {
      const [registry, parserImpl] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        import('@gatewaze-modules/templates/lib/parser/parser-registry.js' as any),
        import('./lib/parser/tsx-marker-parser-impl.js'),
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (registry as any).registerSourceParser('tsx-marker', new (parserImpl as any).TsxMarkerParserImpl());
      console.log('[sites] TSX marker parser registered');
    } catch (err) {
      console.warn('[sites] TSX marker parser registration skipped:', err instanceof Error ? err.message : String(err));
    }
  },

  onDisable: async () => {
    console.log('[sites] Module disabled — pages / sites remain in DB but routes are unmounted');
  },
};

export default sitesModule;
