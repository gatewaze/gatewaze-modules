import type { McpContributions, ModuleRuntimeContext } from '@gatewaze/shared';
import { PUBLIC_EVENT_FIELDS } from './public-api';

export function getEventsMcpContributions(): McpContributions {
  return {
    tools: [
      {
        name: 'search',
        description: 'Search events by title, date range, location, type, or topic. Returns paginated results.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Free-text search across title and description' },
            date_from: { type: 'string', description: 'Start of date range (ISO 8601)' },
            date_to: { type: 'string', description: 'End of date range (ISO 8601)' },
            event_type: { type: 'string', description: 'Filter by event type' },
            city: { type: 'string', description: 'Filter by city (partial match)' },
            topics: { type: 'array', items: { type: 'string' }, description: 'Filter by topics (overlap)' },
            limit: { type: 'number', description: 'Max results (default 25, max 100)' },
            offset: { type: 'number', description: 'Skip N results (default 0)' },
          },
        },
        handler: async (params, ctx) => {
          const supabase = ctx.supabase as any;
          const limit = Math.min(Number(params.limit) || 25, 100);
          const offset = Number(params.offset) || 0;

          let query = supabase
            .from('events')
            .select(PUBLIC_EVENT_FIELDS.join(','), { count: 'exact' })
            .eq('is_listed', true)
            .order('event_start', { ascending: false })
            .range(offset, offset + limit - 1);

          if (params.query) query = query.ilike('event_title', `%${params.query}%`);
          if (params.date_from) query = query.gte('event_start', params.date_from);
          if (params.date_to) query = query.lte('event_start', params.date_to);
          if (params.event_type) query = query.eq('event_type', params.event_type);
          if (params.city) query = query.ilike('event_city', `%${params.city}%`);
          if (params.topics) query = query.overlaps('event_topics', params.topics as string[]);

          const { data, count, error } = await query;
          if (error) throw new Error(`Events search failed: ${error.message}`);
          return { events: data, total: count, limit, offset };
        },
      },
      {
        name: 'get',
        description: 'Get full details of a single event by UUID or short event_id',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Event UUID or short event_id' },
          },
          required: ['id'],
        },
        handler: async (params, ctx) => {
          const supabase = ctx.supabase as any;
          const { data, error } = await supabase
            .from('events')
            .select(PUBLIC_EVENT_FIELDS.join(','))
            .or(`id.eq.${params.id},event_id.eq.${params.id}`)
            .single();
          if (error) throw new Error(`Event not found: ${error.message}`);
          return data;
        },
      },
      {
        name: 'stats',
        description: 'Get aggregate event statistics — total count, breakdown by type, top cities, upcoming count',
        inputSchema: {
          type: 'object',
          properties: {
            date_from: { type: 'string', description: 'Start of date range (ISO 8601)' },
            date_to: { type: 'string', description: 'End of date range (ISO 8601)' },
          },
        },
        handler: async (params, ctx) => {
          const supabase = ctx.supabase as any;

          // Total count
          let countQuery = supabase.from('events').select('id', { count: 'exact', head: true });
          if (params.date_from) countQuery = countQuery.gte('event_start', params.date_from);
          if (params.date_to) countQuery = countQuery.lte('event_start', params.date_to);
          const { count: totalCount } = await countQuery;

          // By type
          const { data: events } = await supabase
            .from('events')
            .select('event_type, event_city')
            .gte('event_start', params.date_from || '1970-01-01')
            .lte('event_start', params.date_to || '2100-01-01');

          const byType: Record<string, number> = {};
          const byCity: Record<string, number> = {};
          for (const e of events ?? []) {
            byType[e.event_type || 'unknown'] = (byType[e.event_type || 'unknown'] || 0) + 1;
            if (e.event_city) byCity[e.event_city] = (byCity[e.event_city] || 0) + 1;
          }

          // Upcoming
          const { count: upcomingCount } = await supabase
            .from('events')
            .select('id', { count: 'exact', head: true })
            .gte('event_start', new Date().toISOString());

          return {
            total: totalCount,
            upcoming: upcomingCount,
            by_type: byType,
            top_cities: Object.entries(byCity)
              .sort(([, a], [, b]) => (b as number) - (a as number))
              .slice(0, 10)
              .map(([city, count]) => ({ city, count })),
          };
        },
      },
    ],

    resources: [
      {
        uriTemplate: 'gatewaze://modules/events/upcoming',
        name: 'Upcoming Events',
        description: 'List of upcoming events in the next 30 days',
        handler: async (_uri, ctx) => {
          const supabase = ctx.supabase as any;
          const now = new Date();
          const thirtyDays = new Date(now.getTime() + 30 * 86400000);
          const { data } = await supabase
            .from('events')
            .select('id, event_id, event_title, event_start, event_city, event_type')
            .eq('is_listed', true)
            .gte('event_start', now.toISOString())
            .lte('event_start', thirtyDays.toISOString())
            .order('event_start')
            .limit(50);
          return data;
        },
      },
    ],

    prompts: [
      {
        name: 'summarize',
        description: 'Summarize events for a given time period',
        arguments: [
          { name: 'period', description: 'Time period: this-week, this-month, or YYYY-MM', required: false },
        ],
        handler: async (args) => {
          return `Analyze the events in this Gatewaze instance for the period "${args.period || 'this month'}".
Use the events_search tool to find events in this period, then provide:
1. Total event count and breakdown by type
2. Geographic distribution (top cities)
3. Most common topics
4. Notable patterns or trends`;
        },
      },
    ],
  };
}
