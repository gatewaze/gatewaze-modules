// Public REST API for resources, mounted by the host at /api/v1/resources
// (basePath derived from the module id). Reads exclusively from the
// sr_public_items view, which is pre-filtered to published items in published,
// access='public' collections — so these endpoints can never expose gated
// content regardless of the API client's privileges.
//
// ctx is the framework PublicApiContext (createPublicApiContext): supabase,
// requireScope, parsePagination, parseFields, setCache. Typed loosely here to
// avoid importing host-only types into the module build.

const PUBLIC_ITEM_FIELDS = [
  'id',
  'title',
  'subtitle',
  'item_slug',
  'collection_slug',
  'collection_name',
  'category_name',
  'featured_image_url',
  'external_url',
  'created_at',
  'updated_at',
] as const;

export function registerPublicApi(router: any, ctx: any): void {
  const supabase = ctx.supabase;
  const cols = PUBLIC_ITEM_FIELDS.join(',');

  // GET / — list public resource items (optionally filtered by collection slug).
  router.get('/', ctx.requireScope('read'), async (req: any, res: any) => {
    try {
      const { limit, offset } = ctx.parsePagination(req.query);
      let q = supabase
        .from('sr_public_items')
        .select(cols, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (req.query.collection) q = q.eq('collection_slug', String(req.query.collection));

      const { data, error, count } = await q;
      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });

      ctx.setCache(res, { kind: 'public', maxAge: 300, sMaxAge: 600 });
      const rows = data ?? [];
      res.json({
        data: rows,
        pagination: { total: count ?? 0, limit, offset, has_more: offset + rows.length < (count ?? 0) },
        _links: { self: req.originalUrl },
      });
    } catch {
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /items/:id — a single public resource item (the /content self-link target).
  router.get('/items/:id', ctx.requireScope('read'), async (req: any, res: any) => {
    try {
      const { data, error } = await supabase
        .from('sr_public_items')
        .select(cols)
        .eq('id', req.params.id)
        .maybeSingle();
      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });
      if (!data) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });

      ctx.setCache(res, { kind: 'public', maxAge: 300, sMaxAge: 600 });
      res.json({ data });
    } catch {
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });
}
