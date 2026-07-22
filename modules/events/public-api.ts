import type { PublicApiContext } from '@gatewaze/shared';
import type { Router, Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Fields safe to expose via the public API — never use select('*') */
export const PUBLIC_EVENT_FIELDS = [
  'id', 'event_id', 'event_title', 'event_description', 'listing_intro',
  'event_start', 'event_end', 'event_timezone',
  'event_city', 'event_country_code', 'event_region', 'event_location',
  'venue_address', 'event_link', 'event_logo', 'event_type',
  'event_topics', 'screenshot_url',
  'enable_registration', 'enable_native_registration',
  'content_category',
] as const;

// Columns as they exist on the events_speakers_with_details view. The
// previous list ('name', 'title', 'bio', …) never matched the view — every
// speakers call 500'd with "column … does not exist".
const PUBLIC_SPEAKER_FIELDS = [
  'id', 'full_name', 'job_title', 'company', 'speaker_bio', 'avatar_url',
  'linkedin_url', 'role', 'sort_order', 'is_featured', 'speaker_topic',
  'talk_title', 'talk_synopsis',
] as const;

const PUBLIC_SPONSOR_FIELDS = [
  'id', 'sponsor_name', 'sponsor_logo_url', 'sponsorship_tier',
  'tier', 'booth_number', 'is_active',
] as const;

export function registerPublicApi(router: Router, ctx: PublicApiContext) {
  const supabase = ctx.supabase as SupabaseClient;

  // The PUBLISHED rule — must match the portal (sitemap.ts): an event is
  // public only when it is BOTH live in production AND listed. is_listed
  // alone leaks placeholder/internal drafts ("Town Hall N - Placeholder")
  // that are listed but not yet live.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const publicOnly = (q: any) => q.eq('is_live_in_production', true).eq('is_listed', true);

  // `id` is a uuid column — comparing it against a short event_id slug makes
  // PostgREST reject the whole query (invalid uuid input), so `.or(id.eq.X,
  // event_id.eq.X)` can never serve slug lookups. Branch on the key shape.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byIdOrSlug = (q: any, key: string) =>
    UUID_RE.test(key) ? q.eq('id', key) : q.eq('event_id', key);

  /**
   * Resolve an id-or-slug to a PUBLIC event's UUID, or null. The speakers /
   * sponsors sub-routes must gate on the parent event's visibility — querying
   * their tables directly would serve data for unpublished events.
   */
  async function resolvePublicEventUuid(idOrSlug: string): Promise<string | null> {
    const { data } = await byIdOrSlug(
      publicOnly(supabase.from('events').select('id')),
      idOrSlug,
    ).maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  }

  // GET /api/v1/events
  router.get('/', ctx.requireScope('read'), async (req: Request, res: Response) => {
    try {
      const { limit, offset } = ctx.parsePagination(req.query);
      const fields = ctx.parseFields(req.query.fields, [...PUBLIC_EVENT_FIELDS], [...PUBLIC_EVENT_FIELDS]);

      let query = publicOnly(
        supabase
          .from('events')
          .select(fields.join(','), { count: 'exact' }),
      )
        .order('event_start', { ascending: true })
        .range(offset, offset + limit - 1);

      if (req.query.q) query = query.ilike('event_title', `%${req.query.q}%`);
      if (req.query.city) query = query.ilike('event_city', `%${req.query.city}%`);
      if (req.query.type) query = query.eq('event_type', req.query.type);
      if (req.query.topics) query = query.overlaps('event_topics', req.query.topics.split(','));
      if (req.query.from) query = query.gte('event_start', req.query.from);
      if (req.query.to) query = query.lte('event_start', req.query.to);
      if (req.query.content_category) {
        const cats = String(req.query.content_category).split(',').map((s) => s.trim()).filter(Boolean);
        query = cats.length > 1 ? query.in('content_category', cats) : query.eq('content_category', cats[0]);
      }

      // Filter by calendar via subquery — preserves all other filters
      if (req.query.calendar_id) {
        const { data: calEvents } = await supabase
          .from('calendars_events')
          .select('event_id')
          .eq('calendar_id', req.query.calendar_id);
        const eventIds = ((calEvents ?? []) as Array<{ event_id: string }>).map((ce) => ce.event_id);
        if (eventIds.length === 0) {
          ctx.setCache(res, { kind: 'public', maxAge: 60, sMaxAge: 300 });
          return res.json({
            data: [],
            pagination: { total: 0, limit, offset, has_more: false },
            _links: { self: req.originalUrl },
          });
        }
        query = query.in('id', eventIds);
      }

      const { data, count, error } = await query;
      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });

      ctx.setCache(res, { kind: 'public', maxAge: 60, sMaxAge: 300 });
      const hasMore = offset + limit < (count || 0);
      res.json({
        data,
        pagination: { total: count, limit, offset, has_more: hasMore },
        _links: {
          self: req.originalUrl,
          ...(hasMore ? { next: `${req.baseUrl}?offset=${offset + limit}&limit=${limit}` } : {}),
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === 'VALIDATION_ERROR') {
        return res.status(400).json({ error: err });
      }
      console.error('[events] public-api list error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/events/metrics — registration metrics per published event.
  // Requires the events:metrics scope: registrant numbers are operational
  // data, deliberately NOT part of the public read surface (the keyless MCP
  // profile never sees this tool). Registered BEFORE /:id so the literal
  // path isn't swallowed by the param route.
  router.get('/metrics', ctx.requireScope('metrics'), async (req: Request, res: Response) => {
    try {
      const { limit, offset } = ctx.parsePagination(req.query);
      // Cap the page: counts are computed per-event (three head-count
      // queries each) — 50 events = 150 cheap parallel counts, still snappy.
      const pageLimit = Math.min(limit, 50);

      let query = publicOnly(
        supabase
          .from('events')
          .select('id, event_id, event_title, event_start, event_end, event_city, event_country_code, event_type, event_location', { count: 'exact' }),
      )
        .order('event_start', { ascending: false })
        .range(offset, offset + pageLimit - 1);
      if (req.query.q) query = query.ilike('event_title', `%${req.query.q}%`);
      if (req.query.from) query = query.gte('event_start', req.query.from);
      if (req.query.to) query = query.lte('event_start', req.query.to);
      if (req.query.calendar_id) {
        const { data: calEvents } = await supabase
          .from('calendars_events')
          .select('event_id')
          .eq('calendar_id', req.query.calendar_id);
        const ids = ((calEvents ?? []) as Array<{ event_id: string }>).map((ce) => ce.event_id);
        if (ids.length === 0) {
          return res.json({ data: [], pagination: { total: 0, limit: pageLimit, offset, has_more: false } });
        }
        query = query.in('id', ids);
      }

      const { data: events, error, count } = await query;
      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });

      // Exact per-event counts via head requests — immune to PostgREST's
      // 1000-row response cap, which a naive fetch-and-count would hit.
      const rows = await Promise.all(
        ((events ?? []) as Array<Record<string, unknown>>).map(async (ev) => {
          const [registrants, checkedIn, cancelled] = await Promise.all([
            supabase.from('events_registrations').select('id', { count: 'exact', head: true })
              .eq('event_id', ev.id).neq('status', 'cancelled'),
            supabase.from('events_registrations').select('id', { count: 'exact', head: true })
              .eq('event_id', ev.id).neq('status', 'cancelled').eq('checked_in', true),
            supabase.from('events_registrations').select('id', { count: 'exact', head: true })
              .eq('event_id', ev.id).eq('status', 'cancelled'),
          ]);
          return {
            ...ev,
            registrations: {
              registrants: registrants.count ?? 0,
              checked_in: checkedIn.count ?? 0,
              cancelled: cancelled.count ?? 0,
            },
          };
        }),
      );

      ctx.setCache(res, { kind: 'no-store' });
      res.json({
        data: rows,
        pagination: { total: count ?? 0, limit: pageLimit, offset, has_more: offset + rows.length < (count ?? 0) },
        _links: { self: req.originalUrl },
      });
    } catch (err) {
      console.error('[events] public-api metrics error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/events/:id
  router.get('/:id', ctx.requireScope('read'), async (req: Request, res: Response) => {
    try {
      const fields = ctx.parseFields(req.query.fields, [...PUBLIC_EVENT_FIELDS], [...PUBLIC_EVENT_FIELDS]);
      const { data, error } = await byIdOrSlug(
        publicOnly(supabase.from('events').select(fields.join(','))),
        req.params.id,
      ).single();

      if (error || !data) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Event not found' } });
      }

      ctx.setCache(res, { kind: 'public', maxAge: 60, sMaxAge: 600 });
      res.json({
        data,
        _links: {
          self: req.originalUrl,
          speakers: `${req.baseUrl}/${req.params.id}/speakers`,
          sponsors: `${req.baseUrl}/${req.params.id}/sponsors`,
        },
      });
    } catch (err) {
      console.error('[events] public-api get error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/events/:id/speakers
  router.get('/:id/speakers', ctx.requireScope('read'), async (req: Request, res: Response) => {
    try {
      const eventUuid = await resolvePublicEventUuid(req.params.id);
      if (!eventUuid) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Event not found' } });
      }
      const { data, error } = await supabase
        .from('events_speakers_with_details')
        .select(PUBLIC_SPEAKER_FIELDS.join(','))
        .eq('event_uuid', eventUuid)
        // Only confirmed speakers are public — pending/declined submissions
        // are not announced (mirrors the portal speakers rule).
        .eq('status', 'confirmed')
        .order('sort_order');

      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });

      ctx.setCache(res, { kind: 'public', maxAge: 60, sMaxAge: 300 });
      res.json({ data, _links: { self: req.originalUrl } });
    } catch (err) {
      console.error('[events] public-api speakers error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/events/:id/sponsors
  router.get('/:id/sponsors', ctx.requireScope('read'), async (req: Request, res: Response) => {
    try {
      const eventUuid = await resolvePublicEventUuid(req.params.id);
      if (!eventUuid) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Event not found' } });
      }
      const { data, error } = await supabase
        .from('events_sponsors')
        .select(PUBLIC_SPONSOR_FIELDS.join(','))
        .eq('event_id', eventUuid)
        .eq('is_active', true)
        .order('sponsorship_tier');

      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });

      ctx.setCache(res, { kind: 'public', maxAge: 60, sMaxAge: 300 });
      res.json({ data, _links: { self: req.originalUrl } });
    } catch (err) {
      console.error('[events] public-api sponsors error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });
}
