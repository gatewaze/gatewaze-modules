import type { PublicApiContext } from '@gatewaze/shared';

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

const PUBLIC_SPEAKER_FIELDS = [
  'id', 'name', 'title', 'company', 'bio', 'avatar_url',
  'linkedin_url', 'twitter_url', 'website_url',
  'role', 'sort_order', 'is_featured', 'speaker_topic',
] as const;

const PUBLIC_SPONSOR_FIELDS = [
  'id', 'sponsor_name', 'sponsor_logo_url', 'sponsorship_tier',
  'tier', 'booth_number', 'is_active',
] as const;

export function registerPublicApi(router: any, ctx: PublicApiContext) {
  const supabase = ctx.supabase as any;

  // GET /api/v1/events
  router.get('/', ctx.requireScope('read'), async (req: any, res: any) => {
    try {
      const { limit, offset } = ctx.parsePagination(req.query);
      const fields = ctx.parseFields(req.query.fields, [...PUBLIC_EVENT_FIELDS], [...PUBLIC_EVENT_FIELDS]);

      let query = supabase
        .from('events')
        .select(fields.join(','), { count: 'exact' })
        .eq('is_listed', true)
        .order('event_start', { ascending: true })
        .range(offset, offset + limit - 1);

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
        const eventIds = (calEvents ?? []).map((ce: any) => ce.event_id);
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
    } catch (err: any) {
      if (err.code === 'VALIDATION_ERROR') {
        return res.status(400).json({ error: err });
      }
      console.error('[events] public-api list error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/events/:id
  router.get('/:id', ctx.requireScope('read'), async (req: any, res: any) => {
    try {
      const fields = ctx.parseFields(req.query.fields, [...PUBLIC_EVENT_FIELDS], [...PUBLIC_EVENT_FIELDS]);
      const { data, error } = await supabase
        .from('events')
        .select(fields.join(','))
        .or(`id.eq.${req.params.id},event_id.eq.${req.params.id}`)
        .eq('is_listed', true)
        .single();

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
    } catch (err: any) {
      console.error('[events] public-api get error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/events/:id/speakers
  router.get('/:id/speakers', ctx.requireScope('read'), async (req: any, res: any) => {
    try {
      const { data, error } = await supabase
        .from('events_speakers_with_details')
        .select(PUBLIC_SPEAKER_FIELDS.join(','))
        .eq('event_uuid', req.params.id)
        .order('sort_order');

      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });

      ctx.setCache(res, { kind: 'public', maxAge: 60, sMaxAge: 300 });
      res.json({ data, _links: { self: req.originalUrl } });
    } catch (err: any) {
      console.error('[events] public-api speakers error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/events/:id/sponsors
  router.get('/:id/sponsors', ctx.requireScope('read'), async (req: any, res: any) => {
    try {
      const { data, error } = await supabase
        .from('events_sponsors')
        .select(PUBLIC_SPONSOR_FIELDS.join(','))
        .eq('event_id', req.params.id)
        .eq('is_active', true)
        .order('sponsorship_tier');

      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });

      ctx.setCache(res, { kind: 'public', maxAge: 60, sMaxAge: 300 });
      res.json({ data, _links: { self: req.originalUrl } });
    } catch (err: any) {
      console.error('[events] public-api sponsors error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });
}
