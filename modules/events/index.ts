import type { GatewazeModule, ModuleContext } from '@gatewaze/shared';
import { getEventsMcpContributions } from './mcp.js';

const eventsModule: GatewazeModule = {
  id: 'events',
  type: 'feature',
  visibility: 'public',
  group: 'events',
  name: 'Events',
  description: 'Core events management - create, manage, and run events with registrations, attendance tracking, and check-in',
  version: '1.3.0',
  features: [
    'events',
    'events.registrations',
    'events.attendance',
  ],

  apiRoutes: async (app: unknown, context?: ModuleContext) => {
    // Register events as a host-media consumer so the shared
    // <HostMediaTab> + /api/admin/event/:id/media routes know the kind.
    // YouTube + ZIP unpack + albums + sponsor tagging are all enabled
    // (events is the historical home of these features; host-media
    // generalises them).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { registerHostMediaConsumer } = await import('../host-media/lib/registry.js' as any);
    registerHostMediaConsumer({
      hostKind: 'event',
      enableAlbums: true,
      enableSponsorTagging: true,
      enableYouTube: true,
      enableZipUnpack: true,
      contentTables: [
        // Event descriptions reference media via embedded HTML/jsonb;
        // the used-in-rebuild cron walks here to keep host_media.used_in
        // in sync.
        {
          table: 'events',
          staticHostKind: 'event',
          hostIdColumn: 'id',
          contentColumn: 'description',
          consumerType: 'event',
          idColumn: 'id',
          nameColumn: 'name',
        },
      ],
    });
    const { registerRoutes } = await import('./api');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRoutes(app as any, context);
  },

  dependencies: ['content-platform'],

  migrations: [
    'migrations/001_create_events_tables.sql',
    'migrations/002_events_rls_functions.sql',
    'migrations/004_triage_adapter.sql',
    'migrations/005_keyword_adapter.sql',
    'migrations/006_publish_state.sql',
    'migrations/008_register_with_platform.sql',
    'migrations/012_nearby_hotels.sql',
    'migrations/013_speakers_extracted_at.sql',
    'migrations/014_register_event_host_media.sql',
    'migrations/015_speakers_extracted_content_hash.sql',
    // 017 adds next_local_event(): cascade geo->city->region->country lookup of
    // a recipient's next nearby published event, for the newsletter
    // next-local-event personalisation provider
    // (spec-newsletter-personalised-delivery.md B.2).
    'migrations/017_next_local_event.sql',
    // 018: registering for an event converts an outreach prospect
    // (people.contact_kind='prospect') into an 'event_contact' — counterpart
    // of core migration 00042 which owns the contact_kind column.
    'migrations/018_registration_contact_kind.sql',
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
      component: () => import('./admin/pages/EventsShell'),
      requiredFeature: 'events',
    },
    // Static '/events/<tab>' shell routes — matched before the dynamic
    // ':eventId' below so module-contributed tabs (Hosts, Speakers, etc.) work.
    {
      path: 'events/hosts',
      component: () => import('./admin/pages/EventsShell'),
      requiredFeature: 'events',
    },
    {
      path: 'events/speakers',
      component: () => import('./admin/pages/EventsShell'),
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
      icon: 'Ticket',
      requiredFeature: 'events',
      parentGroup: 'dashboards',
      defaultSection: 'Events',
      defaultLocation: 'sidebar',
      order: 100,
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
    icon: 'ticket',
    order: 10,
  },
  // Workspace-shell rail item (spec-portal-workspace-shell.md §8). Public top-level module.
  portalShell: {
    rail: { label: 'Events', full: 'Events', icon: 'ticket', order: 10, visibility: 'public' },
    nav: [],
    publicNav: [],
  },

  publicApiScopes: [
    { action: 'read', description: 'Read public events, including speakers and sponsors via sub-resources' },
    { action: 'metrics', description: 'Read per-event registration metrics (registrants, check-ins) for published events' },
  ],

  publicApiRoutes: async (router, ctx) => {
    const { registerPublicApi } = await import('./public-api');
    // The framework's PublicApiContext type is the source of truth;
    // registerPublicApi accepts an Express Router and a typed ctx.
    registerPublicApi(router as Parameters<typeof registerPublicApi>[0], ctx as Parameters<typeof registerPublicApi>[1]);
  },

  publicApiSchema: {
    tag: { name: 'Events', description: 'Public event data' },
    paths: {
      '/': {
        get: {
          summary: 'List events',
          operationId: 'listEvents',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Filter by event title (partial match)' },
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
      '/metrics': {
        get: {
          summary: 'Registration metrics per published event (requires events:metrics)',
          operationId: 'listEventMetrics',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Filter by event title (partial match)' },
            { name: 'calendar_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, minimum: 1, maximum: 50 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 } },
          ],
          responses: {
            200: { description: 'Events with registrants / checked_in / cancelled counts' },
            403: { $ref: '#/components/responses/Forbidden' },
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
      fields: { id: 'event_id', title: 'event_title', date: 'event_start', summary: 'listing_intro' },
      // PUBLISHED rule — both flags, matching public-api.ts and the portal
      // sitemap. is_listed alone leaks live=false placeholder drafts.
      visibilityFilter: [
        { column: 'is_live_in_production', eq: true },
        { column: 'is_listed', eq: true },
      ],
      resourcePath: (row) => `/events/${row.event_id}`,
      // Mirror PUBLIC_EVENT_FIELDS in public-api.ts — keep in sync when adding fields.
      fullFields: [
        'id', 'event_id', 'event_title', 'event_description', 'listing_intro',
        'event_start', 'event_end', 'event_timezone',
        'event_city', 'event_country_code', 'event_region', 'event_location',
        'venue_address', 'event_link', 'event_logo', 'event_type',
        'event_topics', 'screenshot_url',
        'enable_registration', 'enable_native_registration',
        'content_category',
      ],
    },
  ],

  mcpContributions: () => getEventsMcpContributions(),

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
