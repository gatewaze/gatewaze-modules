import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';

const eventsModule: GatewazeModule = {
  id: 'events',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Events',
  description: 'Core events management - create, manage, and run events with registrations, attendance tracking, and check-in',
  version: '1.0.0',
  features: [
    'events',
    'events.registrations',
    'events.attendance',
  ],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    const { registerRoutes } = await import('./api');
    registerRoutes(app as any, context);
  },

  migrations: [
    'migrations/001_create_events_tables.sql',
    'migrations/002_events_rls_functions.sql',
    'migrations/003_content_category.sql',
    'migrations/004_triage_adapter.sql',
    'migrations/005_keyword_adapter.sql',
  ],

  edgeFunctions: [
    'events',
    'events-registration',
    'events-search',
    'events-generate-matches',
    'events-send-match-emails',
  ],

  adminRoutes: [
    {
      path: 'events',
      component: () => import('./admin/pages/EventsPage'),
      requiredFeature: 'events',
    },
    {
      path: 'events/:eventId',
      component: () => import('./admin/pages/EventDetailPage'),
      requiredFeature: 'events',
    },
    {
      path: 'events/:eventId/:tab',
      component: () => import('./admin/pages/EventDetailPage'),
      requiredFeature: 'events',
    },
  ],

  adminNavItems: [
    {
      path: '/events',
      label: 'Events',
      icon: 'admin.events',
      requiredFeature: 'events',
      parentGroup: 'dashboards',
      order: 15,
    },
  ],

  adminSlots: [
    {
      slotName: 'person-detail:events',
      component: () => import('./admin/components/PersonEventsTab'),
      order: 10,
      requiredFeature: 'events',
    },
  ],

  portalNav: {
    label: 'Events',
    path: '/events/upcoming',
    icon: 'calendar',
    order: 10,
  },

  publicApiScopes: [
    { action: 'read', description: 'Read public events, including speakers and sponsors via sub-resources' },
  ],

  publicApiRoutes: async (router: unknown, ctx: any) => {
    const { registerPublicApi } = await import('./public-api');
    registerPublicApi(router, ctx);
  },

  publicApiSchema: {
    tag: { name: 'Events', description: 'Public event data' },
    paths: {
      '/': {
        get: {
          summary: 'List events',
          operationId: 'listEvents',
          parameters: [
            { name: 'city', in: 'query', schema: { type: 'string' }, description: 'Filter by city (partial match)' },
            { name: 'type', in: 'query', schema: { type: 'string' }, description: 'Filter by event type' },
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Events starting after this date (RFC 3339)' },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Events starting before this date (RFC 3339)' },
            { name: 'topics', in: 'query', schema: { type: 'string' }, description: 'Comma-separated topic filter (overlap match)' },
            { name: 'calendar_id', in: 'query', schema: { type: 'string', format: 'uuid' }, description: 'Filter to events in a specific calendar' },
            { name: 'fields', in: 'query', schema: { type: 'string' }, description: 'Comma-separated field list (sparse fieldset)' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, minimum: 1, maximum: 100 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 } },
          ],
          responses: {
            200: { description: 'Paginated list of events' },
            401: { $ref: '#/components/responses/Unauthorized' },
            403: { $ref: '#/components/responses/Forbidden' },
            429: { $ref: '#/components/responses/RateLimited' },
          },
        },
      },
      '/{id}': {
        get: {
          summary: 'Get event by ID or short event_id',
          operationId: 'getEvent',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'fields', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: { description: 'Event details' },
            404: { $ref: '#/components/responses/NotFound' },
          },
        },
      },
      '/{id}/speakers': {
        get: {
          summary: 'Get speakers for an event',
          operationId: 'getEventSpeakers',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'List of speakers with profile details' } },
        },
      },
      '/{id}/sponsors': {
        get: {
          summary: 'Get sponsors for an event',
          operationId: 'getEventSponsors',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'List of sponsors' } },
        },
      },
    },
    schemas: {
      Event: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          event_id: { type: 'string' },
          event_title: { type: 'string' },
          event_description: { type: 'string' },
          event_start: { type: 'string', format: 'date-time' },
          event_end: { type: 'string', format: 'date-time' },
          event_timezone: { type: 'string' },
          event_city: { type: 'string' },
          event_country_code: { type: 'string' },
          event_type: { type: 'string' },
          event_topics: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },

  publicContentSources: [
    {
      type: 'event',
      table: 'events',
      scope: 'events:read',
      fields: { id: 'id', title: 'event_title', date: 'event_start', summary: 'listing_intro' },
      visibilityFilter: [{ column: 'is_listed', eq: true }],
      resourcePath: (row) => `/events/${row.event_id ?? row.id}`,
    },
  ],

  mcpContributions: () => {
    // Lazy-load to avoid pulling MCP deps into the admin/portal build
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./mcp').getEventsMcpContributions();
  },

  dependencies: [],

  configSchema: {},

  onInstall: async () => {
    console.log('[events] Module installed');
  },

  onEnable: async () => {
    console.log('[events] Module enabled');
  },

  onDisable: async () => {
    console.log('[events] Module disabled');
  },
};

export default eventsModule;
