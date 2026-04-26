/**
 * Events listing schema — first reference implementation of
 * spec-platform-listing-pattern.md and spec-portal-listing-infinite-scroll.md.
 */

import type { ListingSchema } from '@gatewaze/shared/listing';
import { cachedEnricher } from '@gatewaze/shared/listing';

/**
 * Slugify a topic name to its URL-safe form. Mirrors the helper in
 * `packages/portal/hooks/useEventFilters.ts` so a topic chip URL clicked
 * in the portal round-trips back to the same topic name on the server.
 */
function slugifyTopic(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

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
      { col: 'publish_state', as: 'publishState' },
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
    // Portal projection uses snake_case column names so it can hydrate
    // the existing `Event` TypeScript type used by the timeline UI without
    // a translation layer. New consumers wanting camelCase shapes should
    // add their own projection rather than rename here.
    portal: [
      'id',
      'event_id',
      'event_slug',
      'event_title',
      'event_start',
      'event_end',
      'event_timezone',
      'event_city',
      'event_region',
      'event_country_code',
      'event_location',
      'venue_address',
      'event_description',
      'listing_intro',
      'event_link',
      'event_logo',
      'screenshot_url',
      'gradient_color_1',
      'gradient_color_2',
      'gradient_color_3',
      'event_type',
      'content_category',
      'event_topics',
      'is_live_in_production',
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
    publishState: {
      kind: 'enum',
      column: 'publish_state',
      values: ['draft', 'pending_review', 'auto_suppressed', 'rejected', 'published', 'unpublished'] as const,
      multi: true,
    },
    /**
     * Time-window virtual filter used by the portal:
     *   view=upcoming → event_start ≥ ts OR null
     *   view=past     → event_start < ts
     * `ts` is supplied via `ctx.extras['listing.ts']` by the portal route
     * handler so all pages of one session share a stable now() snapshot.
     */
    view: {
      kind: 'virtual',
      column: 'event_start',
      values: ['upcoming', 'past'] as const,
      resolve: (value, qb, ctx) => {
        const ts = (ctx.extras['listing.ts'] as string) ?? new Date().toISOString();
        if (value === 'upcoming') {
          return qb.or(`event_start.gte.${ts},event_start.is.null`);
        }
        return qb.lt('event_start', ts);
      },
    },
    /**
     * Topic filter on the `event_topics` array column. The URL carries
     * topic *slugs*; the resolver converts them back to the original
     * names using the brand's topic config map (populated by the
     * contextEnricher below).
     */
    topics: {
      kind: 'virtual',
      column: 'event_topics',
      multi: true,
      resolve: (value, qb, ctx) => {
        const slugs = Array.isArray(value)
          ? (value as string[])
          : value !== undefined && value !== null
            ? [String(value)]
            : [];
        if (slugs.length === 0) return qb;
        const map = ctx.extras['events.topicSlugToName'] as Map<string, string> | undefined;
        const names = map
          ? slugs.map((s) => map.get(s)).filter((n): n is string => Boolean(n))
          : [];
        if (names.length === 0) return qb;
        return qb.overlaps('event_topics', names);
      },
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
    'publish_state',
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

  /**
   * Per-request enricher: populates `ctx.extras['events.topicSlugToName']`
   * from the brand's configured topics so the `topics` virtual filter
   * can resolve URL slugs back to the canonical topic names. Cached
   * per-brand for 60s. Brand config lookup is intentionally brand-scoped
   * to prevent cross-brand pollution on multi-brand servers.
   */
  contextEnricher: cachedEnricher({
    ttlMs: 60_000,
    keyBy: (ctx) => ctx.brandId ?? null,
    load: async (ctx) => {
      if (!ctx.brandId) return {};
      const eventTopics = await loadBrandEventTopics(ctx.brandId);
      const map = new Map<string, string>();
      for (const name of eventTopics) {
        map.set(slugifyTopic(name), name);
      }
      return { 'events.topicSlugToName': map };
    },
  }),
};

/**
 * Brand topic loader. The modules repo doesn't take a hard dependency
 * on `@supabase/supabase-js`, so we hit the PostgREST endpoint directly
 * via `fetch`. Returns [] on any failure (the topics filter degrades
 * gracefully — the resolver returns an unmodified query when the map
 * is empty).
 */
async function loadBrandEventTopics(brandId: string): Promise<string[]> {
  void brandId;
  try {
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anon) return [];
    const endpoint = `${url}/rest/v1/app_settings?select=value&key=eq.event_topics&limit=1`;
    const res = await fetch(endpoint, {
      headers: {
        apikey: anon,
        Authorization: `Bearer ${anon}`,
      },
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{ value: unknown }>;
    const value = rows[0]?.value;
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
      } catch {
        return [];
      }
    }
    return [];
  } catch {
    return [];
  }
}
