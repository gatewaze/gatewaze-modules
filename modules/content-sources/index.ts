// Before committing: run a security review of your diff (see CLAUDE.md — /security-review or `pragma:security`).
import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';
import { getContentSourcesMcpContributions } from './mcp.js';

/**
 * Content Discovery — where content comes from.
 *
 * A managed registry of feeds and scrape targets (`discovery_sources`), a
 * generic FeedScraper that runs as one row in the standard Scrapers dashboard
 * and lands new posts in the blog module as `pending_review` (so the Content
 * Inbox is the editorial step), a resolver that turns a site URL into feed
 * candidates, and the surfaces to manage the registry: a Sources tab in the
 * Content hub, the public API, and MCP tools.
 *
 * Ported from the LF ED newsletter blog harvest; see
 * spec-content-sources-and-research-blocks.md (Part 1).
 */
const contentDiscoveryModule: GatewazeModule = {
  id: 'content-sources',
  group: 'content',
  type: 'feature',
  visibility: 'public',
  name: 'Content Discovery',
  description:
    'Registry of blog feeds and scrape targets with a generic feed scraper. New posts land in the Content Inbox as pending review; sources are managed in Content → Sources, the public API and MCP.',
  version: '1.1.0',

  features: [
    'content-sources',         // read the registry; the Sources tab
    'content-sources.manage',  // add / approve / pause sources, run the scraper
  ],

  // scrapers: the dashboard + job runner the FeedScraper is contributed to.
  // blog: the landing table. content-platform: record_content_source + the
  // Content hub's Sources section.
  dependencies: ['scrapers', 'blog', 'content-platform'],

  migrations: [
    'migrations/001_discovery_sources.sql',
    'migrations/002_blog_posts_discovery_columns.sql',
    'migrations/003_seed_scraper_row.sql',
    'migrations/004_refetch_bad_bodies.sql',
  ],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api/register-routes');
    registerRoutes(app as never, context);
  },

  adminRoutes: [],
  adminNavItems: [],
  adminSlots: [
    {
      slotName: 'content-hub:sources',
      component: () => import('./admin/pages/SourcesTab'),
      order: 10,
      requiredFeature: 'content-sources',
      meta: {
        tabId: 'discovery-sources',
        label: 'Discovery Sources',
        description: 'Feeds and sites the platform watches for new posts',
      },
    },
  ],

  // ── Public API: /api/v1/content-sources/* ──────────────────────────────
  publicApiScopes: [
    { action: 'read', description: 'List and read discovery sources; resolve a site URL to its feeds' },
    { action: 'write', description: 'Submit a new source (lands as pending until an admin approves)' },
    { action: 'admin', description: 'Change source status, egress, metadata; submissions activate immediately' },
  ],
  publicApiRoutes: async (router, ctx) => {
    const { registerPublicApi } = await import('./api/public-api');
    registerPublicApi(router as never, ctx);
  },

  // ── MCP: catalogued here; callable through the hosted server (packages/mcp) ──
  // mcp.ts holds only the tool schemas; its handlers load the server-side
  // library lazily, so this static import keeps Node-only code out of the
  // admin bundle. The admin Vite plugin stubs dynamic imports of server-only
  // paths such as the mcp file, so the manifest must not import it lazily.
  mcpContributions: () => getContentSourcesMcpContributions(),

  configSchema: {
    default_content_category: {
      key: 'default_content_category',
      type: 'string',
      required: false,
      default: 'ecosystem',
      description: 'content_category given to discovered posts whose source does not set one.',
    },
  },

  onInstall: async () => {
    console.log('[content-sources] installed — a "Discovery feeds" scraper row is seeded; add sources in Content → Sources.');
  },
};

export default contentDiscoveryModule;
