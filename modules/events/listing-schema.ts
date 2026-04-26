/**
 * Events listing schema — first reference implementation of
 * spec-platform-listing-pattern.md.
 */

import type { ListingSchema } from '@gatewaze/shared/listing';

export const eventsListingSchema: ListingSchema = {
  id: 'events',
  table: 'events',
  primaryKey: 'id',
  defaultSort: { column: 'eventStart', direction: 'desc' },

  projections: {
    admin: [
      'id',
      'event_id',
      { col: 'event_title', as: 'eventTitle' },
      { col: 'event_logo', as: 'eventLogo' },
      { col: 'screenshot_url', as: 'screenshotUrl' },
      { col: 'screenshot_generated', as: 'screenshotGenerated' },
      { col: 'event_start', as: 'eventStart' },
      { col: 'event_end', as: 'eventEnd' },
      { col: 'event_city', as: 'eventCity' },
      { col: 'event_country_code', as: 'eventCountryCode' },
      { col: 'event_region', as: 'eventRegion' },
      { col: 'event_type', as: 'eventType' },
      { col: 'is_live_in_production', as: 'isLive' },
      { col: 'scraped_by', as: 'scrapedBy' },
      { col: 'event_link', as: 'eventLink' },
      { col: 'source_type', as: 'sourceType' },
      { col: 'source_event_id', as: 'sourceEventId' },
      { col: 'content_category', as: 'contentCategory' },
      { col: 'created_at', as: 'createdAt' },
      { col: 'updated_at', as: 'updatedAt' },
      // PostgREST nested aggregate — counts rows in events_registrations
      // referencing this event. Cheap when events_registrations.event_id
      // is indexed (it is — the FK). Returns `[{ count: N }]`.
      'events_registrations(count)',
    ],
    publicApi: [
      'id',
      { col: 'event_title', as: 'title' },
      { col: 'event_start', as: 'start' },
      { col: 'event_end', as: 'end' },
      { col: 'event_city', as: 'city' },
      { col: 'event_country_code', as: 'countryCode' },
      { col: 'event_type', as: 'type' },
      { col: 'event_link', as: 'link' },
    ],
    mcp: [
      'id',
      { col: 'event_title', as: 'title' },
      { col: 'event_start', as: 'start' },
      { col: 'event_city', as: 'city' },
      { col: 'event_type', as: 'type' },
    ],
    portal: [
      'id',
      { col: 'event_title', as: 'title' },
      { col: 'event_start', as: 'start' },
      { col: 'event_end', as: 'end' },
      { col: 'event_city', as: 'city' },
      { col: 'event_country_code', as: 'countryCode' },
      { col: 'event_type', as: 'type' },
      { col: 'event_link', as: 'link' },
    ],
  },

  sortable: {
    eventTitle: 'event_title',
    eventStart: 'event_start',
    eventEnd: 'event_end',
    eventCity: 'event_city',
    eventCountryCode: 'event_country_code',
    eventType: 'event_type',
    sourceType: 'source_type',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },

  filters: {
    eventType: {
      kind: 'string',
      column: 'event_type',
      maxLength: 100,
      multi: true,
    },
    sourceType: {
      kind: 'enum',
      column: 'source_type',
      values: ['manual', 'scraper', 'user_submission'] as const,
      multi: true,
    },
    scrapedBy: {
      kind: 'string',
      column: 'scraped_by',
      maxLength: 100,
      multi: true,
    },
    contentCategory: {
      kind: 'string',
      column: 'content_category',
      maxLength: 100,
      multi: true,
    },
    countryCode: {
      kind: 'string',
      column: 'event_country_code',
      maxLength: 2,
      multi: true,
    },
    region: {
      kind: 'string',
      column: 'event_region',
      maxLength: 50,
      multi: true,
    },
    startsAfter: {
      kind: 'date',
      column: 'event_start',
    },
    startsBefore: {
      kind: 'date',
      column: 'event_start',
    },
    // "Hide past" is implemented client-side as `endsAfter=now` — toggling
    // the chip writes the current ISO timestamp into endsAfter.
    endsAfter: {
      kind: 'date',
      column: 'event_end',
    },
    // "No screenshots" — tristate on screenshot_url (NULL = no screenshot).
    screenshot: {
      kind: 'tristate',
      column: 'screenshot_url',
      map: { has: 'NOT NULL', none: 'NULL' },
    },
    isLive: {
      kind: 'boolean',
      column: 'is_live_in_production',
    },
  },

  searchable: ['event_title', 'event_city'],

  // Columns the admin filter UI populates from a distinct endpoint.
  // Each must be indexed (otherwise DISTINCT scans the whole table).
  distinctableColumns: [
    'event_type',
    'source_type',
    'scraped_by',
    'content_category',
    'event_country_code',
    'event_region',
  ],

  indexedColumns: [
    'event_start',
    'created_at',
    'updated_at',
    'event_title',
    'event_end',
    'event_city',
    'event_country_code',
    'event_region',
    'event_type',
    'is_live_in_production',
    'scraped_by',
    'source_type',
    'screenshot_url',
    'content_category',
  ],

  authFilters: {
    admin: null,
    publicApi: () => (q) => q.eq('is_live_in_production', true),
    mcp: () => (q) => q.eq('is_live_in_production', true),
    portal: () => (q) => q.eq('is_live_in_production', true),
  },
};
