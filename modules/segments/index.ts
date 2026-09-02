import type { GatewazeModule } from '@gatewaze/shared';

const segmentsModule: GatewazeModule = {
  id: 'segments',
  group: 'people',
  type: 'feature',
  visibility: 'public',
  name: 'Segments',
  description: 'Create and manage audience segments for targeted communications and analytics',
  version: '1.0.0',
  features: [
    'segments',
    'segments.create',
    'segments.manage',
  ],

  migrations: [
    'migrations/001_segments_tables.sql',
    'migrations/002_segments_functions.sql',
    // 003 wires event_filters (predicates on people_events.event_data) into
    // segments_event_to_sql so "attended an event in San Francisco" is
    // expressible. See spec-campaigns-module.md Phase 3.
    'migrations/003_event_filters.sql',
    // 004 adds a 'subscription' condition (membership in a newsletter/list via
    // list_subscriptions); source=newsletter resolves the list live from the
    // newsletter. First example of cross-module audience targeting.
    'migrations/004_subscription_condition.sql',
    // 005 generalises into a condition-provider registry (segments_condition_sources
    // + segments_sources_catalog + dynamic dispatch); migrates subscription onto it.
    // 006 adds Phase A membership providers: event_registration, calendar_member,
    // ambassador_application. See spec-segments-cross-module-targeting.md.
    'migrations/005_condition_source_registry.sql',
    'migrations/006_membership_providers.sql',
    // 007 resolves event_registered/event_attended against the real events
    // tables so event_filters (event_city, …) work without people_events.
    'migrations/007_event_source_tables.sql',
    // 008 adds geo_radius targeting (haversine on attributes.location) + a
    // self-contained place geocoder from our own contact/event coordinates.
    'migrations/008_geo_radius.sql',
    'migrations/009_geo_aggregate.sql',
    // Topic-interest targeting via the governed signals topic graph.
    'migrations/010_topic_affinity.sql',
    // event_registration: vocab returns the event UUID (not the short code) and
    // the predicate resolves either form — fixes audiences silently going to 0.
    'migrations/011_event_registration_uuid_fix.sql',
    // Smart country/state matching (name<->code both ways) + full_name
    // virtual field for the shared condition engine; MCP segment ownership
    // (created_by_person_id/created_via) + service-role preview entry point.
    'migrations/012_smart_geo_and_mcp.sql',
    'migrations/013_statement_timeout_backstop.sql',
    // 014 keyset-batched materialisation (beats the 8s RPC timeout on large
    // audiences) + excludes synthetic send-testing people from every audience.
    'migrations/014_calc_batch_and_test_exclusion.sql',
    // 015 make the send-testing exclusion opt-outable so deliberate test sends
    // work (audiences referencing the test domain/marker skip the exclusion).
    'migrations/015_test_recipient_optin.sql',
  ],

  publicApiScopes: [
    { action: 'people', description: 'Search the audience through the segment engine and list own segments — PII (names/emails); grant deliberately' },
    { action: 'write', description: 'Save named segments owned by the calling person (MCP surface)' },
  ],

  publicApiRoutes: async (router, ctx) => {
    const { registerPublicApi } = await import('./public-api');
    registerPublicApi(router as Parameters<typeof registerPublicApi>[0], ctx as Parameters<typeof registerPublicApi>[1]);
  },

  publicApiSchema: {
    tag: { name: 'Segments', description: 'Audience search + saved segments (segments:people / segments:write)' },
    paths: {
      '/people': {
        get: {
          summary: 'Search the audience via the segment engine (smart country/state matching, full_name contains, arbitrary attribute conditions)',
          operationId: 'segmentsPeopleSearch',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Full-name contains' },
            { name: 'country', in: 'query', schema: { type: 'string' }, description: "Country name or ISO code — 'Japan' and 'JP' both match all stored forms" },
            { name: 'state', in: 'query', schema: { type: 'string' }, description: "US state name or USPS code — 'CA' and 'California' both match" },
            { name: 'city_contains', in: 'query', schema: { type: 'string' } },
            { name: 'email_contains', in: 'query', schema: { type: 'string' } },
            { name: 'email_not_contains', in: 'query', schema: { type: 'string' }, description: "e.g. 'gmail' for non-Gmail addresses" },
            { name: 'company_contains', in: 'query', schema: { type: 'string' } },
            { name: 'job_title_contains', in: 'query', schema: { type: 'string' } },
            { name: 'free_email', in: 'query', schema: { type: 'string', enum: ['true', 'false'] }, description: 'Precomputed free-vs-work email flag' },
            { name: 'conditions', in: 'query', schema: { type: 'string' }, description: 'JSON array of {field, operator, value} for any attribute' },
            { name: 'match', in: 'query', schema: { type: 'string', enum: ['all', 'any'], default: 'all' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 200 } },
          ],
          responses: { 200: { description: 'Matching people (count + sample rows)' }, 403: { $ref: '#/components/responses/Forbidden' } },
        },
      },
      '/': {
        post: {
          summary: 'Save the filter as a named dynamic segment owned by person_id (created_via=mcp)',
          operationId: 'segmentsCreate',
          responses: { 201: { description: 'Created segment' }, 403: { $ref: '#/components/responses/Forbidden' } },
        },
      },
      '/mine': {
        get: {
          summary: "List the calling person's segments",
          operationId: 'segmentsMine',
          parameters: [{ name: 'person_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Segments created by this person' } },
        },
      },
      '/{id}/people': {
        get: {
          summary: 'Run a saved segment and return its members (count + sample)',
          operationId: 'segmentsRun',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 200 } },
          ],
          responses: { 200: { description: 'Segment members' }, 404: { description: 'Segment not found' } },
        },
      },
    },
  },

  adminRoutes: [
    { path: 'segments', component: () => import('./admin/pages/index'), requiredFeature: 'segments', guard: 'none' },
    { path: 'segments/create', component: () => import('./admin/pages/create'), requiredFeature: 'segments', guard: 'none' },
    { path: 'segments/:id', component: () => import('./admin/pages/[id]/index'), requiredFeature: 'segments', guard: 'none' },
    { path: 'segments/:id/edit', component: () => import('./admin/pages/[id]/index'), requiredFeature: 'segments', guard: 'none' },
  ],

  adminNavItems: [
    { path: '/segments', label: 'Segments', icon: 'Filter', requiredFeature: 'segments', order: 14 },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[segments] Module installed');
  },

  onEnable: async () => {
    console.log('[segments] Module enabled');
  },

  onDisable: async () => {
    console.log('[segments] Module disabled');
  },
};

export default segmentsModule;
