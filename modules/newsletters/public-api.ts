import type { PublicApiContext } from '@gatewaze/shared';

/** Edition fields safe to expose via the public API. */
export const PUBLIC_EDITION_FIELDS = [
  'id', 'title', 'edition_date', 'preheader', 'content_category',
  'collection_id', 'created_at', 'updated_at',
] as const;

/** Newsletter type (collection) fields safe to expose. */
const PUBLIC_COLLECTION_FIELDS = [
  'id', 'name', 'slug', 'description', 'accent_color', 'content_category',
  'from_name', 'is_default',
] as const;

/** Block fields safe to expose for full-edition content fetching. */
const PUBLIC_BLOCK_FIELDS = [
  'id', 'block_type', 'block_order', 'content',
] as const;

const PUBLIC_BRICK_FIELDS = [
  'id', 'block_id', 'brick_type', 'brick_order', 'content',
] as const;

export function registerPublicApi(router: any, ctx: PublicApiContext) {
  const supabase = ctx.supabase as any;

  // GET /api/v1/newsletters — list newsletter types (template collections)
  router.get('/', ctx.requireScope('read'), async (req: any, res: any) => {
    try {
      const { limit, offset } = ctx.parsePagination(req.query);
      const fields = ctx.parseFields(req.query.fields, [...PUBLIC_COLLECTION_FIELDS], [...PUBLIC_COLLECTION_FIELDS]);

      let query = supabase
        .from('newsletters_template_collections')
        .select(fields.join(','), { count: 'exact' })
        .order('name', { ascending: true })
        .range(offset, offset + limit - 1);

      if (req.query.content_category) {
        const cats = String(req.query.content_category).split(',').map((s) => s.trim()).filter(Boolean);
        query = cats.length > 1 ? query.in('content_category', cats) : query.eq('content_category', cats[0]);
      }

      const { data, count, error } = await query;
      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });

      ctx.setCache(res, { kind: 'public', maxAge: 300, sMaxAge: 600 });
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
      if (err.code === 'VALIDATION_ERROR') return res.status(400).json({ error: err });
      console.error('[newsletters] public-api list error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/newsletters/:slug — get a single newsletter type by slug
  router.get('/:slug', ctx.requireScope('read'), async (req: any, res: any) => {
    try {
      const fields = ctx.parseFields(req.query.fields, [...PUBLIC_COLLECTION_FIELDS], [...PUBLIC_COLLECTION_FIELDS]);
      const { data, error } = await supabase
        .from('newsletters_template_collections')
        .select(fields.join(','))
        .eq('slug', req.params.slug)
        .single();

      if (error || !data) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Newsletter not found' } });
      }

      ctx.setCache(res, { kind: 'public', maxAge: 300, sMaxAge: 600 });
      res.json({
        data,
        _links: {
          self: req.originalUrl,
          editions: `${req.baseUrl}/${req.params.slug}/editions`,
        },
      });
    } catch (err: any) {
      console.error('[newsletters] public-api get error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/newsletters/:slug/editions — list published editions for a newsletter type
  router.get('/:slug/editions', ctx.requireScope('read'), async (req: any, res: any) => {
    try {
      const { limit, offset } = ctx.parsePagination(req.query);
      const fields = ctx.parseFields(req.query.fields, [...PUBLIC_EDITION_FIELDS], [...PUBLIC_EDITION_FIELDS]);

      // Resolve collection by slug
      const { data: collection, error: cErr } = await supabase
        .from('newsletters_template_collections')
        .select('id')
        .eq('slug', req.params.slug)
        .single();

      if (cErr || !collection) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Newsletter not found' } });
      }

      let query = supabase
        .from('newsletters_editions')
        .select(fields.join(','), { count: 'exact' })
        .eq('collection_id', collection.id)
        .eq('status', 'published')
        .order('edition_date', { ascending: false })
        .range(offset, offset + limit - 1);

      if (req.query.from) query = query.gte('edition_date', req.query.from);
      if (req.query.to) query = query.lte('edition_date', req.query.to);
      if (req.query.content_category) {
        const cats = String(req.query.content_category).split(',').map((s) => s.trim()).filter(Boolean);
        query = cats.length > 1 ? query.in('content_category', cats) : query.eq('content_category', cats[0]);
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
          ...(hasMore ? { next: `${req.baseUrl}/${req.params.slug}/editions?offset=${offset + limit}&limit=${limit}` } : {}),
        },
      });
    } catch (err: any) {
      if (err.code === 'VALIDATION_ERROR') return res.status(400).json({ error: err });
      console.error('[newsletters] public-api editions list error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/newsletters/editions/:id — get a single edition's metadata
  router.get('/editions/:id', ctx.requireScope('read'), async (req: any, res: any) => {
    try {
      const fields = ctx.parseFields(req.query.fields, [...PUBLIC_EDITION_FIELDS], [...PUBLIC_EDITION_FIELDS]);
      const { data, error } = await supabase
        .from('newsletters_editions')
        .select(fields.join(','))
        .eq('id', req.params.id)
        .eq('status', 'published')
        .single();

      if (error || !data) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Edition not found' } });
      }

      ctx.setCache(res, { kind: 'public', maxAge: 60, sMaxAge: 600 });
      res.json({
        data,
        _links: {
          self: req.originalUrl,
          content: `${req.baseUrl}/editions/${req.params.id}/content`,
        },
      });
    } catch (err: any) {
      console.error('[newsletters] public-api edition get error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/newsletters/editions/:id/content — full block + brick content
  router.get('/editions/:id/content', ctx.requireScope('read'), async (req: any, res: any) => {
    try {
      // Verify edition is published
      const { data: edition, error: eErr } = await supabase
        .from('newsletters_editions')
        .select('id, status, title, edition_date, content_category')
        .eq('id', req.params.id)
        .eq('status', 'published')
        .single();

      if (eErr || !edition) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Edition not found' } });
      }

      // Fetch blocks
      const { data: blocks, error: bErr } = await supabase
        .from('newsletters_edition_blocks')
        .select(PUBLIC_BLOCK_FIELDS.join(','))
        .eq('edition_id', edition.id)
        .order('block_order', { ascending: true });

      if (bErr) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: bErr.message } });

      // Fetch bricks for these blocks (single round-trip, then group)
      const blockIds = (blocks ?? []).map((b: any) => b.id);
      let bricks: any[] = [];
      if (blockIds.length > 0) {
        const { data: brickData, error: brErr } = await supabase
          .from('newsletters_edition_bricks')
          .select(PUBLIC_BRICK_FIELDS.join(','))
          .in('block_id', blockIds)
          .order('brick_order', { ascending: true });
        if (brErr) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: brErr.message } });
        bricks = brickData ?? [];
      }

      // Group bricks by block
      const bricksByBlock: Record<string, any[]> = {};
      for (const b of bricks) {
        (bricksByBlock[b.block_id] ??= []).push({
          id: b.id, brick_type: b.brick_type, brick_order: b.brick_order, content: b.content,
        });
      }

      const blocksWithBricks = (blocks ?? []).map((b: any) => ({
        ...b,
        bricks: bricksByBlock[b.id] ?? [],
      }));

      ctx.setCache(res, { kind: 'public', maxAge: 60, sMaxAge: 600 });
      res.json({
        data: {
          edition: {
            id: edition.id,
            title: edition.title,
            edition_date: edition.edition_date,
            content_category: edition.content_category,
          },
          blocks: blocksWithBricks,
        },
        _links: { self: req.originalUrl },
      });
    } catch (err: any) {
      console.error('[newsletters] public-api edition content error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });
}
