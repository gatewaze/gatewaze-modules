// Public REST API for calendars, mounted by the host at /api/v1/calendars
// (basePath derived from the module id). Read-only directory of PUBLIC
// calendars — the lookup surface agents need to resolve a calendar name
// ("AAIF", "MLOps Community", …) to the calendar_id accepted by
// /api/v1/events?calendar_id=. Visibility rule mirrors the portal sitemap:
// is_active=true AND visibility='public'.
//
// ctx is the framework PublicApiContext (createPublicApiContext): supabase,
// requireScope, parsePagination, setCache. Typed loosely to avoid importing
// host-only types into the module build.

const PUBLIC_CALENDAR_FIELDS = [
  'id',
  'calendar_id',
  'name',
  'slug',
  'description',
  'image_url',
  'logo_url',
  'color',
  'external_url',
  'created_at',
  'updated_at',
] as const;

export function registerPublicApi(router: any, ctx: any): void {
  const supabase = ctx.supabase;
  const cols = PUBLIC_CALENDAR_FIELDS.join(',');

  // event_count must count PUBLISHED events only (is_live_in_production AND
  // is_listed — the portal rule). A raw calendars_events(count) embed counts
  // link rows, advertising events the public events API will never serve —
  // agents see "1 event" then get 0 rows back.
  async function publishedCounts(calendarIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (calendarIds.length === 0) return counts;
    const { data, error } = await supabase
      .from('calendars_events')
      .select('calendar_id, events!inner(id)')
      .in('calendar_id', calendarIds)
      .eq('events.is_live_in_production', true)
      .eq('events.is_listed', true);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      counts.set(row.calendar_id, (counts.get(row.calendar_id) ?? 0) + 1);
    }
    return counts;
  }

  // GET / — list public calendars with their PUBLISHED event counts.
  router.get('/', ctx.requireScope('read'), async (req: any, res: any) => {
    try {
      const { limit, offset } = ctx.parsePagination(req.query);
      let q = supabase
        .from('calendars')
        .select(cols, { count: 'exact' })
        .eq('is_active', true)
        .eq('visibility', 'public')
        .order('name', { ascending: true })
        .range(offset, offset + limit - 1);
      if (req.query.q) q = q.ilike('name', `%${String(req.query.q)}%`);

      const { data, error, count } = await q;
      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });

      const counts = await publishedCounts((data ?? []).map((r: any) => r.id));
      const rows = (data ?? []).map((row: any) => ({
        ...row,
        event_count: counts.get(row.id) ?? 0,
      }));

      ctx.setCache(res, { kind: 'public', maxAge: 300, sMaxAge: 600 });
      res.json({
        data: rows,
        pagination: { total: count ?? 0, limit, offset, has_more: offset + rows.length < (count ?? 0) },
        _links: { self: req.originalUrl },
      });
    } catch (err: any) {
      const status = err?.statusCode ?? 500;
      res.status(status).json({ error: { code: err?.code ?? 'INTERNAL', message: err?.message ?? 'Internal server error' } });
    }
  });

  // GET /:id — a single public calendar by UUID, external calendar_id, or slug.
  router.get('/:id', ctx.requireScope('read'), async (req: any, res: any) => {
    try {
      const key = String(req.params.id);
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
      const { data, error } = await supabase
        .from('calendars')
        .select(cols)
        .eq('is_active', true)
        .eq('visibility', 'public')
        .or(isUuid ? `id.eq.${key}` : `calendar_id.eq.${key},slug.eq.${key}`)
        .maybeSingle();
      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });
      if (!data) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Calendar not found' } });

      const counts = await publishedCounts([data.id]);
      ctx.setCache(res, { kind: 'public', maxAge: 300, sMaxAge: 600 });
      res.json({ data: { ...data, event_count: counts.get(data.id) ?? 0 } });
    } catch (err: any) {
      res.status(500).json({ error: { code: 'INTERNAL', message: err?.message ?? 'Internal server error' } });
    }
  });
}
