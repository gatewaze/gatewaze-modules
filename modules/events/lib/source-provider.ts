/**
 * Events source provider — registers events as a queryable source for
 * gatewaze-internal blocks.
 *
 * Per spec-content-modules-git-architecture §17.1.
 *
 * Modules wire this in their onEnable hook:
 *
 *   import { gatewazeSourceProvider } from '@gatewaze-modules/sites/lib/auth/source-provider';
 *   import { eventsSourceProvider } from './source-provider';
 *   gatewazeSourceProvider(eventsSourceProvider());
 */

export interface EventsFilter {
  type?: 'conference' | 'meetup' | 'workshop' | 'webinar' | 'all';
  status?: 'upcoming' | 'live' | 'past' | 'all';
  location_country?: string;
  tags?: string[];
}

export interface EventRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string | null;
  url: string | null;
  event_type: string;
  location_country: string | null;
}

export interface EventsConfig {
  filter: EventsFilter;
  sort: 'start_date_asc' | 'start_date_desc' | 'created_at_desc' | 'name_asc';
  limit: number;
  include_specific_ids?: string[];
}

interface UserContext {
  id: string;
  email: string;
}

export interface FieldDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'reference';
  label: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  referenceEntity?: string;
}

export interface SourceProviderShape {
  slug: string;
  displayName: string;
  configSchema: Record<string, unknown>;
  filterFields: FieldDefinition[];
  sortOptions: Array<{ value: string; label: string }>;
  supportedAudiences: Array<'public' | 'authenticated' | 'authenticated_optional'>;
  fetch(config: EventsConfig, ctx: { user: UserContext | null; siteId: string }): Promise<EventRow[]>;
}

export interface EventsProviderDeps {
  /** Narrow Supabase shape used at runtime (admin or anon depending on caller). */
  supabase: {
    from(table: string): {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      select(cols: string): any;
    };
  };
}

export function eventsSourceProvider(deps: EventsProviderDeps): SourceProviderShape {
  return {
    slug: 'events',
    displayName: 'Events',
    configSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['conference', 'meetup', 'workshop', 'webinar', 'all'], default: 'all' },
            status: { type: 'string', enum: ['upcoming', 'live', 'past', 'all'], default: 'upcoming' },
            location_country: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
        sort: { type: 'string', enum: ['start_date_asc', 'start_date_desc', 'created_at_desc', 'name_asc'], default: 'start_date_asc' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 5 },
        include_specific_ids: { type: 'array', items: { type: 'string' } },
      },
    },
    filterFields: [
      { name: 'type', type: 'enum', label: 'Type', options: [
        { value: 'all', label: 'All' },
        { value: 'conference', label: 'Conference' },
        { value: 'meetup', label: 'Meetup' },
        { value: 'workshop', label: 'Workshop' },
        { value: 'webinar', label: 'Webinar' },
      ]},
      { name: 'status', type: 'enum', label: 'Status', options: [
        { value: 'upcoming', label: 'Upcoming' },
        { value: 'live', label: 'Live now' },
        { value: 'past', label: 'Past' },
        { value: 'all', label: 'All' },
      ]},
      { name: 'location_country', type: 'string', label: 'Country' },
      { name: 'tags', type: 'string', label: 'Tags' },
    ],
    sortOptions: [
      { value: 'start_date_asc', label: 'Start date — soonest first' },
      { value: 'start_date_desc', label: 'Start date — latest first' },
      { value: 'created_at_desc', label: 'Most recently added' },
      { value: 'name_asc', label: 'Name (A → Z)' },
    ],
    supportedAudiences: ['public', 'authenticated', 'authenticated_optional'],

    async fetch(config, _ctx) {
      // RLS does the per-viewer authorization; we just pass the query through.
      // Pinned events fetched in a second query and merged.
      let q = deps.supabase.from('events').select('id, name, start_date, end_date, url, event_type, location_country');

      if (config.filter.type && config.filter.type !== 'all') {
        q = q.eq('event_type', config.filter.type);
      }
      if (config.filter.status === 'upcoming') {
        q = q.gte('start_date', new Date().toISOString());
      } else if (config.filter.status === 'past') {
        q = q.lt('start_date', new Date().toISOString());
      }
      if (config.filter.location_country) {
        q = q.eq('location_country', config.filter.location_country);
      }
      if (config.filter.tags && config.filter.tags.length > 0) {
        q = q.contains('tags', config.filter.tags);
      }

      const sortColumn = config.sort.startsWith('start_date') ? 'start_date'
        : config.sort.startsWith('created_at') ? 'created_at'
        : 'name';
      const ascending = config.sort.endsWith('_asc');
      q = q.order(sortColumn, { ascending }).limit(config.limit);

      const { data: filterResults } = await q;
      let merged: EventRow[] = (filterResults as EventRow[]) ?? [];

      // Append pinned events (de-duplicated by id, prepended for visibility)
      if (config.include_specific_ids && config.include_specific_ids.length > 0) {
        const { data: pinned } = await deps.supabase
          .from('events')
          .select('id, name, start_date, end_date, url, event_type, location_country')
          .in('id', config.include_specific_ids);
        const pinnedRows = (pinned as EventRow[]) ?? [];
        const seen = new Set(pinnedRows.map((p) => p.id));
        merged = [...pinnedRows, ...merged.filter((e) => !seen.has(e.id))];
      }

      return merged;
    },
  };
}
