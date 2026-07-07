// Management REST API for structured resources, mounted alongside the public
// read endpoints at /api/v1/resources. Every route requires the
// `resources:write` API-key scope — these endpoints see and mutate draft
// content, so they are deliberately not covered by `resources:read`.
//
// This is the programmatic write path used by the Gatewaze MCP server's
// resources_* tools (packages/mcp) and any other API-key integration. It
// mirrors the admin UI's structuredResourcesService semantics: slugs are
// generated from names/titles and de-duplicated server-side, items can carry
// an ordered set of sections, and PUT /items/:id/sections replaces the full
// section list.
//
// ctx is the framework PublicApiContext (createPublicApiContext): supabase
// (service role), requireScope, parsePagination, setCache. Typed loosely to
// avoid importing host-only types into the module build.

const COLLECTION_FIELDS = [
  'name', 'slug', 'description', 'cover_image_url', 'status', 'access',
  'meta_title', 'meta_description', 'sort_order',
] as const;

const ITEM_FIELDS = [
  'category_id', 'title', 'slug', 'subtitle', 'external_url',
  'featured_image_url', 'status', 'sort_order',
] as const;

const STATUSES = ['draft', 'published', 'archived'] as const;
const ACCESS_LEVELS = ['public', 'authenticated', 'inherit'] as const;

function generateSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function ensureUniqueSlug(
  supabase: any,
  baseSlug: string,
  table: 'sr_collections' | 'sr_categories' | 'sr_items',
  scopeField?: string,
  scopeValue?: string,
  excludeId?: string,
): Promise<string> {
  const fallback = baseSlug || 'untitled';
  let slug = fallback;
  let counter = 1;
  // Bounded loop: 100 collisions on one base slug means something is wrong.
  while (counter <= 100) {
    let q = supabase.from(table).select('id').eq('slug', slug).limit(1);
    if (scopeField && scopeValue) q = q.eq(scopeField, scopeValue);
    if (excludeId) q = q.neq('id', excludeId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return slug;
    slug = `${fallback}-${counter}`;
    counter++;
  }
  throw new Error(`could not find a unique slug for '${fallback}'`);
}

function sendError(res: any, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** Copy allowed body fields into a row, validating enums. Returns an error string or null. */
function pickFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
  row: Record<string, unknown>,
): string | null {
  for (const field of allowed) {
    if (!(field in body) || body[field] === undefined) continue;
    const value = body[field];
    if (field === 'status') {
      if (!STATUSES.includes(value as any)) return `status must be one of: ${STATUSES.join(', ')}`;
    } else if (field === 'access') {
      if (!ACCESS_LEVELS.includes(value as any)) return `access must be one of: ${ACCESS_LEVELS.join(', ')}`;
    } else if (field === 'sort_order') {
      if (!Number.isInteger(value)) return 'sort_order must be an integer';
    } else if (value !== null && typeof value !== 'string') {
      return `${field} must be a string or null`;
    }
    row[field] = value;
  }
  return null;
}

interface SectionInput {
  heading: string;
  content: string | null;
  template_id: string | null;
  sort_order: number;
}

/** Validate a sections array from a request body. Returns [rows, error]. */
function parseSections(raw: unknown): [SectionInput[], string | null] {
  if (raw === undefined || raw === null) return [[], null];
  if (!Array.isArray(raw)) return [[], 'sections must be an array'];
  const rows: SectionInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] as Record<string, unknown>;
    const heading = str(s?.heading);
    if (!heading) return [[], `sections[${i}].heading is required`];
    if (s.content !== undefined && s.content !== null && typeof s.content !== 'string') {
      return [[], `sections[${i}].content must be a string or null`];
    }
    if (s.template_id !== undefined && s.template_id !== null && typeof s.template_id !== 'string') {
      return [[], `sections[${i}].template_id must be a string or null`];
    }
    rows.push({
      heading,
      content: (s.content as string | null) ?? null,
      template_id: (s.template_id as string | null) ?? null,
      sort_order: Number.isInteger(s.sort_order) ? (s.sort_order as number) : i,
    });
  }
  return [rows, null];
}

export function registerManageApi(router: any, ctx: any): void {
  const supabase = ctx.supabase;
  const write = ctx.requireScope('write');

  // ── Collections ─────────────────────────────────────────────────────────

  // GET /collections — list ALL collections (drafts included), with counts.
  router.get('/collections', write, async (req: any, res: any) => {
    try {
      const { limit, offset } = ctx.parsePagination(req.query);
      const { data, error, count } = await supabase
        .from('sr_collections')
        .select('*', { count: 'exact' })
        .order('sort_order', { ascending: true })
        .range(offset, offset + limit - 1);
      if (error) return sendError(res, 500, 'QUERY_ERROR', error.message);
      res.json({
        data: data ?? [],
        pagination: { total: count ?? 0, limit, offset, has_more: offset + (data?.length ?? 0) < (count ?? 0) },
      });
    } catch (err: any) {
      sendError(res, err?.statusCode ?? 500, err?.code ?? 'INTERNAL', err?.message ?? 'Internal server error');
    }
  });

  // POST /collections — create a collection. Slug is generated from the name
  // when omitted and always de-duplicated.
  router.post('/collections', write, async (req: any, res: any) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = str(body.name);
      if (!name) return sendError(res, 400, 'VALIDATION_ERROR', 'name is required');

      const row: Record<string, unknown> = {};
      const fieldError = pickFields(body, COLLECTION_FIELDS, row);
      if (fieldError) return sendError(res, 400, 'VALIDATION_ERROR', fieldError);
      row.name = name;
      row.slug = await ensureUniqueSlug(supabase, str(body.slug) ?? generateSlug(name), 'sr_collections');

      const { data, error } = await supabase.from('sr_collections').insert(row).select().single();
      if (error) return sendError(res, 500, 'QUERY_ERROR', error.message);
      res.status(201).json({ data });
    } catch (err: any) {
      sendError(res, 500, 'INTERNAL', err?.message ?? 'Internal server error');
    }
  });

  // GET /collections/:id — collection detail with its categories and section
  // templates (everything needed to author items into it).
  router.get('/collections/:id', write, async (req: any, res: any) => {
    try {
      const { data: collection, error } = await supabase
        .from('sr_collections')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();
      if (error) return sendError(res, 500, 'QUERY_ERROR', error.message);
      if (!collection) return sendError(res, 404, 'NOT_FOUND', 'Collection not found');

      const [cats, templates] = await Promise.all([
        supabase.from('sr_categories').select('*').eq('collection_id', collection.id).order('sort_order'),
        supabase.from('sr_section_templates').select('*').eq('collection_id', collection.id).order('sort_order'),
      ]);
      if (cats.error) return sendError(res, 500, 'QUERY_ERROR', cats.error.message);
      if (templates.error) return sendError(res, 500, 'QUERY_ERROR', templates.error.message);

      res.json({ data: { ...collection, categories: cats.data ?? [], section_templates: templates.data ?? [] } });
    } catch (err: any) {
      sendError(res, 500, 'INTERNAL', err?.message ?? 'Internal server error');
    }
  });

  // PATCH /collections/:id — update collection fields (e.g. publish it).
  router.patch('/collections/:id', write, async (req: any, res: any) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updates: Record<string, unknown> = {};
      const fieldError = pickFields(body, COLLECTION_FIELDS, updates);
      if (fieldError) return sendError(res, 400, 'VALIDATION_ERROR', fieldError);
      if ('name' in updates && !str(updates.name)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'name cannot be empty');
      }
      if (Object.keys(updates).length === 0) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'no updatable fields provided');
      }
      if (typeof updates.slug === 'string') {
        updates.slug = await ensureUniqueSlug(
          supabase, generateSlug(updates.slug), 'sr_collections', undefined, undefined, req.params.id,
        );
      }
      const { data, error } = await supabase
        .from('sr_collections').update(updates).eq('id', req.params.id).select().maybeSingle();
      if (error) return sendError(res, 500, 'QUERY_ERROR', error.message);
      if (!data) return sendError(res, 404, 'NOT_FOUND', 'Collection not found');
      res.json({ data });
    } catch (err: any) {
      sendError(res, 500, 'INTERNAL', err?.message ?? 'Internal server error');
    }
  });

  // ── Categories & section templates ──────────────────────────────────────

  // POST /collections/:id/categories — create a category in a collection.
  router.post('/collections/:id/categories', write, async (req: any, res: any) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = str(body.name);
      if (!name) return sendError(res, 400, 'VALIDATION_ERROR', 'name is required');

      const { data: collection } = await supabase
        .from('sr_collections').select('id').eq('id', req.params.id).maybeSingle();
      if (!collection) return sendError(res, 404, 'NOT_FOUND', 'Collection not found');

      const row: Record<string, unknown> = {
        collection_id: collection.id,
        name,
        slug: await ensureUniqueSlug(
          supabase, str(body.slug) ?? generateSlug(name), 'sr_categories', 'collection_id', collection.id,
        ),
        description: str(body.description) ?? null,
        icon: str(body.icon) ?? null,
        sort_order: Number.isInteger(body.sort_order) ? body.sort_order : 0,
      };
      const { data, error } = await supabase.from('sr_categories').insert(row).select().single();
      if (error) return sendError(res, 500, 'QUERY_ERROR', error.message);
      res.status(201).json({ data });
    } catch (err: any) {
      sendError(res, 500, 'INTERNAL', err?.message ?? 'Internal server error');
    }
  });

  // POST /collections/:id/templates — create a section template.
  router.post('/collections/:id/templates', write, async (req: any, res: any) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const heading = str(body.heading);
      if (!heading) return sendError(res, 400, 'VALIDATION_ERROR', 'heading is required');

      const { data: collection } = await supabase
        .from('sr_collections').select('id').eq('id', req.params.id).maybeSingle();
      if (!collection) return sendError(res, 404, 'NOT_FOUND', 'Collection not found');

      const row = {
        collection_id: collection.id,
        heading,
        description: str(body.description) ?? null,
        is_required: body.is_required === true,
        sort_order: Number.isInteger(body.sort_order) ? body.sort_order : 0,
      };
      const { data, error } = await supabase.from('sr_section_templates').insert(row).select().single();
      if (error) return sendError(res, 500, 'QUERY_ERROR', error.message);
      res.status(201).json({ data });
    } catch (err: any) {
      sendError(res, 500, 'INTERNAL', err?.message ?? 'Internal server error');
    }
  });

  // ── Items ────────────────────────────────────────────────────────────────

  // GET /collections/:id/items — list a collection's items (all statuses,
  // optional ?status= filter), with the joined category.
  router.get('/collections/:id/items', write, async (req: any, res: any) => {
    try {
      const { limit, offset } = ctx.parsePagination(req.query);
      let q = supabase
        .from('sr_items')
        .select('*, category:sr_categories(id, name, slug)', { count: 'exact' })
        .eq('collection_id', req.params.id)
        .order('sort_order', { ascending: true })
        .range(offset, offset + limit - 1);
      const status = str(req.query.status);
      if (status) {
        if (!STATUSES.includes(status as any)) {
          return sendError(res, 400, 'VALIDATION_ERROR', `status must be one of: ${STATUSES.join(', ')}`);
        }
        q = q.eq('status', status);
      }
      const { data, error, count } = await q;
      if (error) return sendError(res, 500, 'QUERY_ERROR', error.message);
      res.json({
        data: data ?? [],
        pagination: { total: count ?? 0, limit, offset, has_more: offset + (data?.length ?? 0) < (count ?? 0) },
      });
    } catch (err: any) {
      sendError(res, err?.statusCode ?? 500, err?.code ?? 'INTERNAL', err?.message ?? 'Internal server error');
    }
  });

  // POST /collections/:id/items — create an item, optionally with its ordered
  // sections in the same call.
  router.post('/collections/:id/items', write, async (req: any, res: any) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = str(body.title);
      const categoryId = str(body.category_id);
      if (!title) return sendError(res, 400, 'VALIDATION_ERROR', 'title is required');
      if (!categoryId) return sendError(res, 400, 'VALIDATION_ERROR', 'category_id is required');

      const [sections, sectionsError] = parseSections(body.sections);
      if (sectionsError) return sendError(res, 400, 'VALIDATION_ERROR', sectionsError);

      // The category must exist and belong to this collection.
      const { data: category } = await supabase
        .from('sr_categories')
        .select('id, collection_id')
        .eq('id', categoryId)
        .maybeSingle();
      if (!category || category.collection_id !== req.params.id) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'category_id does not belong to this collection');
      }

      const row: Record<string, unknown> = { collection_id: req.params.id };
      const fieldError = pickFields(body, ITEM_FIELDS, row);
      if (fieldError) return sendError(res, 400, 'VALIDATION_ERROR', fieldError);
      row.title = title;
      row.slug = await ensureUniqueSlug(
        supabase, str(body.slug) ?? generateSlug(title), 'sr_items', 'collection_id', req.params.id,
      );

      const { data: item, error } = await supabase.from('sr_items').insert(row).select().single();
      if (error) return sendError(res, 500, 'QUERY_ERROR', error.message);

      if (sections.length > 0) {
        const { error: secError } = await supabase
          .from('sr_sections')
          .insert(sections.map((s) => ({ ...s, item_id: item.id })));
        if (secError) {
          // Don't leave a half-created item behind — the caller will retry.
          await supabase.from('sr_items').delete().eq('id', item.id);
          return sendError(res, 500, 'QUERY_ERROR', `sections insert failed: ${secError.message}`);
        }
      }

      res.status(201).json({ data: { ...item, sections } });
    } catch (err: any) {
      sendError(res, 500, 'INTERNAL', err?.message ?? 'Internal server error');
    }
  });

  // GET /items/:id/manage — full item (any status) with ordered sections.
  // Distinct from the public GET /items/:id, which only sees published items
  // in public collections via the sr_public_items view.
  router.get('/items/:id/manage', write, async (req: any, res: any) => {
    try {
      const { data, error } = await supabase
        .from('sr_items')
        .select('*, category:sr_categories(id, name, slug), sections:sr_sections(*)')
        .eq('id', req.params.id)
        .maybeSingle();
      if (error) return sendError(res, 500, 'QUERY_ERROR', error.message);
      if (!data) return sendError(res, 404, 'NOT_FOUND', 'Item not found');
      data.sections = (data.sections ?? []).sort((a: any, b: any) => a.sort_order - b.sort_order);
      res.json({ data });
    } catch (err: any) {
      sendError(res, 500, 'INTERNAL', err?.message ?? 'Internal server error');
    }
  });

  // PATCH /items/:id — update item fields (title, status to publish, etc.).
  router.patch('/items/:id', write, async (req: any, res: any) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updates: Record<string, unknown> = {};
      const fieldError = pickFields(body, ITEM_FIELDS, updates);
      if (fieldError) return sendError(res, 400, 'VALIDATION_ERROR', fieldError);
      if ('title' in updates && !str(updates.title)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'title cannot be empty');
      }
      if (Object.keys(updates).length === 0) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'no updatable fields provided');
      }

      const { data: current } = await supabase
        .from('sr_items').select('id, collection_id').eq('id', req.params.id).maybeSingle();
      if (!current) return sendError(res, 404, 'NOT_FOUND', 'Item not found');

      if (typeof updates.category_id === 'string') {
        const { data: category } = await supabase
          .from('sr_categories').select('collection_id').eq('id', updates.category_id).maybeSingle();
        if (!category || category.collection_id !== current.collection_id) {
          return sendError(res, 400, 'VALIDATION_ERROR', "category_id does not belong to the item's collection");
        }
      }
      if (typeof updates.slug === 'string') {
        updates.slug = await ensureUniqueSlug(
          supabase, generateSlug(updates.slug), 'sr_items', 'collection_id', current.collection_id, current.id,
        );
      }

      const { data, error } = await supabase
        .from('sr_items').update(updates).eq('id', req.params.id).select().single();
      if (error) return sendError(res, 500, 'QUERY_ERROR', error.message);
      res.json({ data });
    } catch (err: any) {
      sendError(res, 500, 'INTERNAL', err?.message ?? 'Internal server error');
    }
  });

  // PUT /items/:id/sections — replace the item's full section list.
  router.put('/items/:id/sections', write, async (req: any, res: any) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const [sections, sectionsError] = parseSections(body.sections);
      if (sectionsError) return sendError(res, 400, 'VALIDATION_ERROR', sectionsError);

      const { data: item } = await supabase
        .from('sr_items').select('id').eq('id', req.params.id).maybeSingle();
      if (!item) return sendError(res, 404, 'NOT_FOUND', 'Item not found');

      const { error: delError } = await supabase.from('sr_sections').delete().eq('item_id', item.id);
      if (delError) return sendError(res, 500, 'QUERY_ERROR', delError.message);

      if (sections.length > 0) {
        const { error: insError } = await supabase
          .from('sr_sections')
          .insert(sections.map((s) => ({ ...s, item_id: item.id })));
        if (insError) return sendError(res, 500, 'QUERY_ERROR', insError.message);
      }

      res.json({ data: { item_id: item.id, sections } });
    } catch (err: any) {
      sendError(res, 500, 'INTERNAL', err?.message ?? 'Internal server error');
    }
  });
}
