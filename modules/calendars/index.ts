import type { GatewazeModule } from '@gatewaze/shared';

const calendarsModule: GatewazeModule = {
  id: 'calendars',
  group: 'events',
  type: 'feature',
  visibility: 'public',
  name: 'Calendars',
  description: 'Manage event calendars with discovery, CSV import, and scheduling APIs',
  version: '1.1.0',
  features: [
    'calendars',
    'calendars.discover',
    'calendars.import',
  ],

  publicApiScopes: [
    { action: 'read', description: 'Read the public calendar directory' },
  ],

  publicApiRoutes: async (router: unknown, ctx: unknown) => {
    const { registerPublicApi } = await import('./public-api');
    registerPublicApi(router, ctx);
  },

  publicApiSchema: {
    tag: { name: 'Calendars', description: 'Public calendar directory' },
    paths: {
      '/': {
        get: {
          summary: 'List public calendars with event counts',
          operationId: 'listCalendars',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Filter by name (partial match)' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, minimum: 1, maximum: 100 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 } },
          ],
          responses: { 200: { description: 'Paginated list of public calendars' } },
        },
      },
      '/{id}': {
        get: {
          summary: 'Get a public calendar by UUID, external calendar_id, or slug',
          operationId: 'getCalendar',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Calendar with event count' }, 404: { $ref: '#/components/responses/NotFound' } },
        },
      },
    },
  },

  edgeFunctions: [
    'calendars-api',
    'calendars-discover',
    'calendars-process-csv',
    'calendars-inbound-email',
  ],

  // Scheduled-blast dispatcher — picks up calendars_blasts rows whose
  // scheduled_at has passed and routes them to email-batch-send (or
  // SMS/WhatsApp dispatchers when those modules ship).
  // Per spec-calendars-microsites §9.3 (Schedule action).
  workers: [
    {
      name: 'calendars:dispatch-scheduled-blasts',
      handler: './workers/dispatch-scheduled-blasts.ts',
    },
  ],

  crons: [
    {
      // 60s tick — admins schedule with datetime-local (minute precision),
      // so anything finer-grained is wasted polling. The CAS update guard
      // in the dispatcher means it's safe to run multiple workers.
      name: 'calendars-dispatch-scheduled-blasts',
      queue: 'jobs',
      schedule: { every: 60_000 },
      data: { kind: 'calendars:dispatch-scheduled-blasts' },
    },
  ],

  dependencies: ['events', 'scrapers'],

  migrations: [
    'migrations/001_calendars_tables.sql',
    'migrations/002_dynamic_members_functions.sql',
    'migrations/003_calendar_microsite.sql',
    'migrations/004_calendar_messaging.sql',
    'migrations/005_calendar_email_groups.sql',
    'migrations/008_admin_calendar_rpcs.sql',
    'migrations/010_calendar_luma_stats.sql',
    'migrations/011_calendar_luma_robust_stats.sql',
    'migrations/012_about_pages_and_audience_scope.sql',
    'migrations/013_calendars_public_read_policy.sql',
    'migrations/014_calendars_events_public_read_policy.sql',
    'migrations/014_calendars_admin_write_policies.sql',
    'migrations/015_register_pages_host.sql',
    'migrations/016_luma_sync_enabled.sql',
  ],

  adminRoutes: [
    { path: 'calendars', component: () => import('./admin/pages/index'), requiredFeature: 'calendars', guard: 'none' },
    { path: 'calendars/:calendarId', component: () => import('./admin/pages/detail'), requiredFeature: 'calendars', guard: 'none' },
    { path: 'calendars/:calendarId/:tab', component: () => import('./admin/pages/detail'), requiredFeature: 'calendars', guard: 'none' },
  ],

  adminNavItems: [
    { path: '/calendars', label: 'Calendars', icon: 'Calendar', requiredFeature: 'calendars', defaultSection: 'Events', defaultLocation: 'sidebar', order: 110 },
  ],

  // Portal nav entry. Visibility (show/hide), label, and order are configurable
  // per-instance via the admin "Portal Navigation" settings page, which writes
  // to platform_settings.portal_nav_overrides (same mechanism used for events,
  // blog, newsletters, etc.).
  portalNav: {
    label: 'Calendars',
    path: '/calendars',
    icon: 'calendar',
    order: 15,
  },

  portalRoutes: [
    { path: '/calendars', component: () => import('./portal/pages/index') },
    { path: '/calendars/:slug', component: () => import('./portal/pages/[slug]/index') },
    { path: '/calendars/:slug/about', component: () => import('./portal/pages/[slug]/about') },
    { path: '/calendars/:slug/chat', component: () => import('./portal/pages/[slug]/chat') },
    { path: '/calendars/:slug/events', component: () => import('./portal/pages/[slug]/events') },
    { path: '/calendars/:slug/join', component: () => import('./portal/pages/[slug]/join') },
    { path: '/calendars/:slug/leaderboard', component: () => import('./portal/pages/[slug]/leaderboard') },
    { path: '/calendars/:slug/media', component: () => import('./portal/pages/[slug]/media') },
    { path: '/calendars/:slug/submit-talk', component: () => import('./portal/pages/[slug]/submit-talk') },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[calendars] Module installed');
  },

  onEnable: async () => {
    console.log('[calendars] Module enabled');
  },

  onDisable: async () => {
    console.log('[calendars] Module disabled');
  },
};

export default calendarsModule;
