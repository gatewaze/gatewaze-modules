import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

const scrapersModule: GatewazeModule = {
  id: 'scrapers',
  group: 'platform',
  type: 'feature',
  visibility: 'hidden',
  name: 'Scrapers',
  description: 'Configure and run web scraping jobs for event discovery and content aggregation',
  version: '1.2.0',
  features: [
    'scrapers',
    'scrapers.manage',
    'scrapers.schedules',
    'scrapers.event-hosts',
  ],

  dependencies: ['content-platform', 'events'],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api');
    registerRoutes(app as any, context);
  },

  workers: [
    {
      name: 'scraper:run',
      handler: './scripts/scraper-worker-entry.js',
      concurrency: 2,
    },
    {
      // Bulk speaker extraction enqueued at the end of every scrape run.
      // Concurrency 1 — Anthropic rate limit + per-brand budget are the
      // serializing constraints; running parallel jobs would just race
      // each other to BudgetExceededError.
      name: 'scraper:speaker-extract',
      handler: './scripts/workers/speaker-extract-handler.js',
      concurrency: 1,
    },
  ],

  migrations: [
    'migrations/001_scrapers_tables.sql',
    'migrations/002_seed_example_scrapers.sql',
    'migrations/003_content_category.sql',
    'migrations/004_scrapers_get_with_status_category.sql',
    'migrations/005_seed_title_filters_and_categories.sql',
    'migrations/006_scraper_reliability.sql',
    'migrations/007_seed_luma_search_scrapers.sql',
    'migrations/008_event_hosts.sql',
    'migrations/009_event_luma_counts.sql',
    'migrations/010_event_hosts_leaderboard.sql',
    'migrations/011_scrapers_base_url_partial_unique.sql',
    'migrations/012_event_hosts_is_company.sql',
    'migrations/013_scrapers_base_url_nullable.sql',
    'migrations/014_triage_mode.sql',
    'migrations/015_event_hosts_events_scanned_at.sql',
    'migrations/016_leaderboard_date_range.sql',
    'migrations/017_default_publish_state.sql',
    'migrations/018_fast_vs_slow_comparison.sql',
    'migrations/019_started_at_on_pickup.sql',
    'migrations/020_event_type_manual_wins.sql',
    'migrations/021_seed_luma_pending_events_scraper.sql',
  ],

  adminRoutes: [
    {
      path: 'scrapers',
      component: () => import('./admin/pages/index'),
      requiredFeature: 'scrapers',
      guard: 'admin',
    },
    {
      // spec-scrapling-fetcher-service.md §4.6 — slow vs Fast comparison.
      path: 'scrapers/comparison',
      component: () => import('./admin/pages/ScraperComparisonPage'),
      requiredFeature: 'scrapers',
      guard: 'admin',
    },
  ],

  adminSlots: [
    {
      slotName: 'event-detail:tab',
      component: () => import('./admin/components/EventHostsTab'),
      order: 25,
      requiredFeature: 'scrapers.event-hosts',
      meta: { tabId: 'hosts', label: 'Hosts', icon: 'UserGroupIcon' },
    },
    // Contribute "Hosts" as a top-level tab on the Events dashboard
    // (rendered by gatewaze-modules/modules/events/admin/pages/EventsShell).
    {
      slotName: 'events:tab',
      component: () => import('./admin/pages/EventHostsPage'),
      order: 10,
      requiredFeature: 'scrapers.event-hosts',
      meta: { tabId: 'hosts', label: 'Hosts', icon: 'UserGroupIcon' },
    },
  ],

  adminNavItems: [
    {
      path: '/admin/scrapers',
      label: 'Scrapers',
      icon: 'Globe',
      requiredFeature: 'scrapers',
      parentGroup: 'admin',
      order: 29,
    },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[scrapers] Module installed');
  },

  onEnable: async () => {
    console.log('[scrapers] Module enabled');
  },

  onDisable: async () => {
    console.log('[scrapers] Module disabled');
  },
};

export default scrapersModule;
