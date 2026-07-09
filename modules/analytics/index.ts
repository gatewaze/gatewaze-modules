import type { GatewazeModule } from '@gatewaze/shared';

/**
 * Umami Analytics module — first-party analytics + tracking-script pipeline.
 *
 * Combines what used to be two separate modules:
 *   - the legacy `umami` integration (sites-only, BYO Umami via URL+token)
 *   - the v1 `analytics` platform module (multi-host, bundled Umami via Helm,
 *     property-based tenancy, dashboards, sessions/replay, ingest pipeline)
 *
 * Per spec-analytics-module.md:
 *   - Self-hosted Umami on the existing Supabase Postgres in v1
 *   - Property-based tenancy (one per Gatewaze site, portal, external)
 *   - First-class Segment integration (per-property write key)
 *   - Generalised custom-script-block facility (per-property head/body)
 *   - analyticsService abstraction so the storage backend can be swapped
 *     to ClickHouse / Tinybird later without touching consumer code
 *
 * Three integration modes:
 *   - sites module pages — automatic via renderer
 *   - portal app — opt-in via brand config
 *   - external sites — manual via copy-paste snippet
 *
 * Two operator deployment modes:
 *   - Bundled: ships a Helm sub-chart that runs Umami as a single-replica
 *     Deployment against the existing platform Postgres (no Docker socket,
 *     no host filesystem, no Supabase CLI — bootstrapped via a Helm
 *     pre-install Job). The default for self-hosted Gatewaze.
 *   - Bring-your-own: point UMAMI_BASE_URL at an existing Umami instance
 *     and supply UMAMI_USERNAME/UMAMI_PASSWORD. The bundled Helm chart can
 *     be skipped by leaving its `enabled` value off in values.yaml.
 */
const analyticsModule: GatewazeModule = {
  id: 'analytics',
  group: 'analytics',
  type: 'integration',
  visibility: 'public',
  name: 'Umami Analytics',
  description:
    'First-party analytics backed by self-hosted Umami. Auto-provisions a Umami "website" entry per Gatewaze site, portal, and external host; injects per-property tracking snippets; surfaces dashboards (pageviews, sessions, replay deep-link, cohorts, retention) and a generalised custom-script pipeline. Includes first-class Segment integration.',
  version: '0.2.0',

  features: ['analytics', 'tracking-scripts', 'segment-integration'],

  // Schema lives in the `analytics` schema in the existing Postgres.
  // Umami's own schema (gatewaze_umami database) is bootstrapped by the
  // Helm pre-install Job, not these migrations — see helm/templates/
  // job-bootstrap-db.yaml.
  migrations: [
    'migrations/00001_analytics_schema.sql',
    'migrations/00002_properties.sql',
    'migrations/00003_tracking_scripts.sql',
    'migrations/00004_provisioning_jobs.sql',
    'migrations/00005_service_helpers.sql',
    'migrations/00006_sites_integration.sql',
    'migrations/00007_portal_site_dedup.sql',
    'migrations/00008_saved_reports.sql',
  ],

  // Provisioning queue: when an analytics_property row is inserted with
  // status='pending', the worker creates the matching Umami `website`
  // entity via Umami's REST API and writes the resulting website_uuid
  // back. Idempotent on retry.
  workers: [
    {
      name: 'analytics:provision-property',
      handler: './src/workers/provisioning.ts',
    },
  ],

  // Cron: rotate share tokens (Umami's read-only iframe URLs) for any
  // properties using the iframe-fallback embed. v1 doesn't expose this
  // surface in the admin UI; the cron is wired up so the schema + worker
  // are exercised when a future feature uses share tokens.
  crons: [
    {
      // Drives the analytics_provisioning_jobs queue: turns queued
      // analytics_properties rows into Umami `website` entities and
      // writes the website_uuid back. Worker is idempotent on retry
      // (Umami POST /api/websites is idempotent on (name, domain)).
      name: 'analytics-provision-property',
      queue: 'jobs',
      schedule: { every: 60 * 1000 },
      data: { kind: 'analytics:provision-property' },
    },
    {
      name: 'analytics-share-token-rotation',
      queue: 'jobs',
      schedule: { every: 24 * 60 * 60 * 1000 },
      data: { kind: 'analytics:share-token-rotation' },
    },
  ],

  // HTTP routes: /api/analytics/* (admin-side property + dashboard) and
  // /a/* (public ingest endpoint, mounted on the portal so it's same-
  // origin with sites pages). Wired by api/register-routes.ts.
  apiRoutes: async (app: unknown, context?: unknown) => {
    const { registerRoutes } = await import('./src/routes/register-routes.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRoutes(app as any, context as any);
  },

  configSchema: {
    UMAMI_BASE_URL: {
      key: 'UMAMI_BASE_URL',
      type: 'string',
      required: false,
      default: 'http://umami:3000',
      description:
        'Internal Umami service URL. Defaults to the in-cluster Service name from the bundled Helm chart. Override only if running Umami separately.',
    },
    UMAMI_USERNAME: {
      key: 'UMAMI_USERNAME',
      type: 'string',
      required: true,
      description: 'Admin username for the Umami API. Created by the bootstrap Job; mirrored into a Kubernetes Secret.',
    },
    UMAMI_PASSWORD: {
      key: 'UMAMI_PASSWORD',
      type: 'string',
      required: true,
      description: 'Admin password for the Umami API. Stored in the platform secrets store; never logged.',
    },
    ANALYTICS_RETENTION_DAYS: {
      key: 'ANALYTICS_RETENTION_DAYS',
      type: 'number',
      required: false,
      default: '395',
      description: 'Days of pageview/event data to retain. Default 13 months. Pruned by a daily Helm CronJob.',
    },
    ANALYTICS_INGEST_PER_IP_RPM: {
      key: 'ANALYTICS_INGEST_PER_IP_RPM',
      type: 'number',
      required: false,
      default: '200',
      description: 'Per-IP rate limit on the /a/collect ingest endpoint. Sliding window over 60s.',
    },
    ANALYTICS_INGEST_PER_PROPERTY_RPM: {
      key: 'ANALYTICS_INGEST_PER_PROPERTY_RPM',
      type: 'number',
      required: false,
      default: '5000',
      description: 'Per-property rate limit on /a/collect. Sliding window over 60s.',
    },
    ANALYTICS_EMBED_CACHE_MAX_AGE_SECONDS: {
      key: 'ANALYTICS_EMBED_CACHE_MAX_AGE_SECONDS',
      type: 'number',
      required: false,
      default: '300',
      description: 'Cache-Control max-age for the /a/<property_id>.js embed bundle.',
    },
  },

  // Single visible nav item — top-level "Analytics" surface lists
  // properties + drills into per-property dashboards.
  adminNavItems: [
    {
      path: '/analytics',
      label: 'Analytics',
      icon: 'BarChart3',
      requiredFeature: 'analytics',
      parentGroup: 'admin',
      order: 25,
    },
  ],

  adminRoutes: [
    {
      path: 'analytics',
      component: () => import('./src/admin/PropertyListPage'),
      requiredFeature: 'analytics',
      guard: 'none',
    },
    {
      path: 'analytics/properties/:id',
      component: () => import('./src/admin/PropertyDashboardPage'),
      requiredFeature: 'analytics',
      guard: 'none',
    },
    {
      path: 'analytics/properties/:id/settings',
      component: () => import('./src/admin/PropertySettingsPage'),
      requiredFeature: 'analytics',
      guard: 'none',
    },
  ],
};

export default analyticsModule;
