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

import {
  validateBlock,
  projectSearchText,
  generateTalkSlug,
  serializeItemVersion,
  describeKinds,
  type BlockInput,
  type ValidationIssue,
} from './blocks';

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

function sendError(
  res: any, status: number, code: string, message: string,
  details?: { path?: string; meta?: Record<string, unknown> },
): void {
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
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

interface BlockRow extends BlockInput {
  search_text: string | null;
}

interface SectionInput {
  heading: string;
  content: string | null;
  template_id: string | null;
  sort_order: number;
  blocks: BlockRow[];
}

const MAX_SECTIONS_PER_REQUEST = 50;
const MAX_BLOCKS_PER_REPLACE = 1000;
const MAX_BLOCKS_PER_SECTION_PUT = 200;
const CONTENT_MAX_CHARS = 500_000;

interface ApiIssue { message: string; path?: string; reason?: string; status?: number }

function issueOf(v: ValidationIssue): ApiIssue {
  return { message: v.message, path: v.path, reason: v.keyword };
}

/** Structural parse of one raw block (schema/kind validation happens in prepareBlocks). */
function parseBlock(raw: unknown, path: string): [BlockRow | null, ApiIssue | null] {
  const b = raw as Record<string, unknown>;
  if (typeof b !== 'object' || b === null) return [null, { message: 'must be an object', path }];
  if (typeof b.kind !== 'string') return [null, { message: 'kind is required', path: `${path}.kind`, reason: 'required' }];
  if (b.slug !== undefined && b.slug !== null && typeof b.slug !== 'string') {
    return [null, { message: 'slug must be a string or null', path: `${path}.slug`, reason: 'type' }];
  }
  if (b.sort_order !== undefined && !Number.isInteger(b.sort_order)) {
    return [null, { message: 'sort_order must be an integer (numeric strings are rejected)', path: `${path}.sort_order`, reason: 'type' }];
  }
  return [{
    kind: b.kind,
    slug: (b.slug as string | null) ?? null,
    sort_order: (b.sort_order as number) ?? 0,
    data: (typeof b.data === 'object' && b.data !== null && !Array.isArray(b.data) ? b.data : {}) as Record<string, unknown>,
    search_text: null,
  }, null];
}

/** Validate a sections array from a request body (now with optional blocks). Returns [rows, issue]. */
function parseSections(raw: unknown): [SectionInput[], ApiIssue | null] {
  if (raw === undefined || raw === null) return [[], null];
  if (!Array.isArray(raw)) return [[], { message: 'sections must be an array', path: 'sections' }];
  if (raw.length > MAX_SECTIONS_PER_REQUEST) {
    return [[], { message: `at most ${MAX_SECTIONS_PER_REQUEST} sections per request`, path: 'sections', reason: 'payload_too_large', status: 413 }];
  }
  const rows: SectionInput[] = [];
  let totalBlocks = 0;
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] as Record<string, unknown>;
    const heading = str(s?.heading);
    if (!heading) return [[], { message: 'heading is required', path: `sections[${i}].heading`, reason: 'required' }];
    if (s.content !== undefined && s.content !== null && typeof s.content !== 'string') {
      return [[], { message: 'content must be a string or null', path: `sections[${i}].content`, reason: 'type' }];
    }
    if (typeof s.content === 'string' && s.content.length > CONTENT_MAX_CHARS) {
      return [[], { message: 'content exceeds 500k characters', path: `sections[${i}].content`, reason: 'payload_too_large', status: 413 }];
    }
    if (s.template_id !== undefined && s.template_id !== null && typeof s.template_id !== 'string') {
      return [[], { message: 'template_id must be a string or null', path: `sections[${i}].template_id`, reason: 'type' }];
    }
    const blocks: BlockRow[] = [];
    if (s.blocks !== undefined && s.blocks !== null) {
      if (!Array.isArray(s.blocks)) {
        return [[], { message: 'blocks must be an array', path: `sections[${i}].blocks`, reason: 'type' }];
      }
      for (let j = 0; j < s.blocks.length; j++) {
        const [block, issue] = parseBlock(s.blocks[j], `sections[${i}].blocks[${j}]`);
        if (issue) return [[], issue];
        if (block!.sort_order === 0 && (s.blocks[j] as any)?.sort_order === undefined) block!.sort_order = j;
        blocks.push(block!);
      }
    }
    // API-layer XOR rule (after defaulting; null and '' both count as empty).
    // Both-empty is allowed — a heading-only section is legitimate scaffolding.
    const contentNonEmpty = typeof s.content === 'string' && s.content.trim().length > 0;
    if (contentNonEmpty && blocks.length > 0) {
      return [[], { message: 'a section payload must not specify both content and blocks', path: `sections[${i}]`, reason: 'content_blocks_xor' }];
    }
    totalBlocks += blocks.length;
    rows.push({
      heading,
      content: (s.content as string | null) ?? null,
      template_id: (s.template_id as string | null) ?? null,
      sort_order: Number.isInteger(s.sort_order) ? (s.sort_order as number) : i,
      blocks,
    });
  }
  if (totalBlocks > MAX_BLOCKS_PER_REPLACE) {
    return [[], { message: `at most ${MAX_BLOCKS_PER_REPLACE} blocks per request`, path: 'sections', reason: 'payload_too_large', status: 413 }];
  }
  return [rows, null];
}

/**
 * Kind-validate blocks, apply the talk slug rules (item-wide pre-write
 * title-match reuse, else generation), compute search_text, and enforce
 * item-scoped slug uniqueness across the payload. `preWriteTalks` maps
 * title -> slug from the item's blocks as they exist before this write
 * (first by sort_order, id); `reservedSlugs` seeds slugs that already exist
 * outside the replaced scope (granular endpoint only).
 */
function prepareBlocks(
  sections: SectionInput[],
  preWriteTalks: Map<string, string>,
  reservedSlugs: Set<string>,
  pathPrefix: (si: number, bi: number) => string,
): ApiIssue | null {
  const taken = new Set<string>(reservedSlugs);
  for (let i = 0; i < sections.length; i++) {
    const blocks = sections[i].blocks;
    for (let j = 0; j < blocks.length; j++) {
      const block = blocks[j];
      const path = pathPrefix(i, j);
      // talk slug rules before validation (requireSlug would otherwise fail)
      if (block.kind === 'talk' && !block.slug) {
        const title = typeof block.data.title === 'string' ? block.data.title : '';
        const reused = preWriteTalks.get(title);
        block.slug = reused && !taken.has(reused) ? reused : generateTalkSlug(title || 'untitled', taken);
      }
      const issues = validateBlock(block, path);
      if (issues.length > 0) {
        const first = issues[0];
        return {
          message: issues.map((v) => `${v.path}: ${v.message}`).join('; '),
          path: first.path,
          reason: first.keyword,
          status: first.keyword === 'payload_too_large' ? 413 : 400,
        };
      }
      if (block.slug) {
        if (taken.has(block.slug)) {
          return { message: 'slug must be unique within the item', path: `${path}.slug`, reason: 'slug_conflict', status: 409 };
        }
        taken.add(block.slug);
      }
      block.search_text = projectSearchText(block.kind, block.data);
    }
  }
  return null;
}

/**
 * Resolve the optional if_match token to the timestamptz string the atomic
 * RPCs compare against. Returns [value, issue]; value null when omitted.
 */
function parseIfMatch(body: Record<string, unknown>): [string | null, ApiIssue | null] {
  if (body.if_match === undefined || body.if_match === null) return [null, null];
  if (typeof body.if_match !== 'string') {
    return [null, { message: 'if_match must be a string', path: 'if_match', reason: 'if_match_invalid' }];
  }
  try {
    serializeItemVersion(body.if_match);
  } catch {
    return [null, { message: 'if_match is not a valid version token', path: 'if_match', reason: 'if_match_invalid' }];
  }
  return [body.if_match, null];
}

/** Map an atomic-RPC error onto the API error contract. */
function sendRpcError(res: any, error: { code?: string; message?: string }): void {
  if (error.code === 'P0409') {
    return sendError(res, 409, 'CONFLICT', 'item version mismatch', { meta: { reason: 'version_mismatch' } });
  }
  if (error.code === 'P0404') {
    return sendError(res, 404, 'NOT_FOUND', error.message ?? 'not found', { meta: { reason: 'foreign_key_violation' } });
  }
  if (error.code === '23505') {
    return sendError(res, 409, 'CONFLICT', 'slug must be unique within the item', { meta: { reason: 'slug_conflict', constraint: 'sr_blocks_item_slug_key' } });
  }
  sendError(res, 500, 'QUERY_ERROR', error.message ?? 'write failed');
}

const BLOCK_COLUMNS = 'id, kind, slug, sort_order, data';

function sortBlocks<T extends { sort_order: number; id: string }>(blocks: T[]): T[] {
  return blocks.sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1));
}

/** Re-read an item's sections with blocks for write responses / manage reads. */
async function readItemTree(supabase: any, itemId: string) {
  const { data: item, error } = await supabase
    .from('sr_items')
    .select(`*, category:sr_categories(id, name, slug), sections:sr_sections(id, heading, content, template_id, sort_order, blocks:sr_blocks(${BLOCK_COLUMNS}))`)
    .eq('id', itemId)
    .maybeSingle();
  if (error || !item) return { item: null, error };
  item.sections = (item.sections ?? []).sort((a: any, b: any) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1));
  for (const s of item.sections) s.blocks = sortBlocks(s.blocks ?? []);
  return { item, error: null };
}

/** Item-wide pre-write talk slug map (title -> slug, first by sort_order,id). */
async function preWriteTalkSlugs(supabase: any, itemId: string): Promise<Map<string, string>> {
  const { data } = await supabase
    .from('sr_blocks')
    .select('id, slug, sort_order, data')
    .eq('item_id', itemId)
    .eq('kind', 'talk')
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    const title = typeof row.data?.title === 'string' ? row.data.title : null;
    if (title && row.slug && !map.has(title)) map.set(title, row.slug);
  }
  return map;
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

      const [sections, sectionsIssue] = parseSections(body.sections);
      if (sectionsIssue) {
        return sendError(res, sectionsIssue.status ?? 400, sectionsIssue.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR',
          sectionsIssue.message, { path: sectionsIssue.path, meta: { reason: sectionsIssue.reason } });
      }
      const blocksIssue = prepareBlocks(sections, new Map(), new Set(), (si, bi) => `sections[${si}].blocks[${bi}]`);
      if (blocksIssue) {
        const code = blocksIssue.status === 409 ? 'CONFLICT' : blocksIssue.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR';
        return sendError(res, blocksIssue.status ?? 400, code, blocksIssue.message, { path: blocksIssue.path, meta: { reason: blocksIssue.reason } });
      }

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
        const { error: secError } = await supabase.rpc('sr_replace_item_sections', {
          p_item_id: item.id,
          p_sections: sections,
          p_expected_version: null,
        });
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

  // GET /items/:id/manage — full item (any status) with ordered sections and
  // their blocks. Distinct from the public GET /items/:id, which only sees
  // published items in public collections via the sr_public_items view.
  // `version` is the canonical if_match token (echo it verbatim on writes).
  router.get('/items/:id/manage', write, async (req: any, res: any) => {
    try {
      const { item, error } = await readItemTree(supabase, req.params.id);
      if (error) return sendError(res, 500, 'QUERY_ERROR', error.message);
      if (!item) return sendError(res, 404, 'NOT_FOUND', 'Item not found');
      // response carries the concurrency token and draft content
      res.set?.('Cache-Control', 'no-store');
      res.json({ data: { ...item, version: serializeItemVersion(item.updated_at) } });
    } catch (err: any) {
      sendError(res, 500, 'INTERNAL', err?.message ?? 'Internal server error');
    }
  });

  // GET /block-kinds — registered block kinds + their JSON Schemas, so API/AI
  // clients can author valid blocks without guessing.
  router.get('/block-kinds', write, async (_req: any, res: any) => {
    res.json({ data: describeKinds() });
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

  // PUT /items/:id/sections — replace the item's full section list, each
  // section carrying either legacy `content` or a `blocks` array (never both).
  // Destructive full-replace: sections absent from the payload are deleted;
  // block/section ids regenerate (slugs are the stable identifiers). Atomic
  // via the sr_replace_item_sections RPC. Optional `if_match` = the version
  // token from GET /items/:id/manage; stale -> 409, omitted -> last-write-wins.
  router.put('/items/:id/sections', write, async (req: any, res: any) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const [ifMatch, ifMatchIssue] = parseIfMatch(body);
      if (ifMatchIssue) return sendError(res, 400, 'VALIDATION_ERROR', ifMatchIssue.message, { path: ifMatchIssue.path, meta: { reason: ifMatchIssue.reason } });

      const [sections, sectionsIssue] = parseSections(body.sections);
      if (sectionsIssue) {
        return sendError(res, sectionsIssue.status ?? 400, sectionsIssue.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR',
          sectionsIssue.message, { path: sectionsIssue.path, meta: { reason: sectionsIssue.reason } });
      }

      const { data: item } = await supabase
        .from('sr_items').select('id, collection_id').eq('id', req.params.id).maybeSingle();
      if (!item) return sendError(res, 404, 'NOT_FOUND', 'Item not found');

      // template_id must reference a template in the item's collection
      const templateIds = [...new Set(sections.map((s) => s.template_id).filter(Boolean))] as string[];
      if (templateIds.length > 0) {
        const { data: templates } = await supabase
          .from('sr_section_templates').select('id').eq('collection_id', item.collection_id).in('id', templateIds);
        const known = new Set((templates ?? []).map((t: any) => t.id));
        const badIdx = sections.findIndex((s) => s.template_id && !known.has(s.template_id));
        if (badIdx !== -1) {
          return sendError(res, 400, 'VALIDATION_ERROR', "template_id does not belong to the item's collection",
            { path: `sections[${badIdx}].template_id`, meta: { reason: 'schema_violation' } });
        }
      }

      const preWrite = await preWriteTalkSlugs(supabase, item.id);
      const blocksIssue = prepareBlocks(sections, preWrite, new Set(), (si, bi) => `sections[${si}].blocks[${bi}]`);
      if (blocksIssue) {
        const code = blocksIssue.status === 409 ? 'CONFLICT' : blocksIssue.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR';
        return sendError(res, blocksIssue.status ?? 400, code, blocksIssue.message, { path: blocksIssue.path, meta: { reason: blocksIssue.reason } });
      }

      const { error: rpcError } = await supabase.rpc('sr_replace_item_sections', {
        p_item_id: item.id,
        p_sections: sections,
        p_expected_version: ifMatch,
      });
      if (rpcError) return sendRpcError(res, rpcError);

      const { item: fresh, error: readError } = await readItemTree(supabase, item.id);
      if (readError || !fresh) return sendError(res, 500, 'QUERY_ERROR', readError?.message ?? 'read-back failed');
      res.set?.('Cache-Control', 'no-store');
      res.json({
        data: {
          item_id: fresh.id,
          item: { id: fresh.id, updated_at: serializeItemVersion(fresh.updated_at) },
          sections: fresh.sections,
        },
      });
    } catch (err: any) {
      sendError(res, 500, 'INTERNAL', err?.message ?? 'Internal server error');
    }
  });

  // PUT /items/:itemId/sections/:sectionId/blocks — replace ONE section's
  // blocks without resending the item's other sections (the incremental
  // editing path). Never mutates sr_sections.content; an empty array deletes
  // all blocks, reverting the section to legacy content rendering.
  router.put('/items/:itemId/sections/:sectionId/blocks', write, async (req: any, res: any) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const [ifMatch, ifMatchIssue] = parseIfMatch(body);
      if (ifMatchIssue) return sendError(res, 400, 'VALIDATION_ERROR', ifMatchIssue.message, { path: ifMatchIssue.path, meta: { reason: ifMatchIssue.reason } });

      if (!Array.isArray(body.blocks)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'blocks must be an array', { path: 'blocks', meta: { reason: 'type' } });
      }
      if (body.blocks.length > MAX_BLOCKS_PER_SECTION_PUT) {
        return sendError(res, 413, 'PAYLOAD_TOO_LARGE', `at most ${MAX_BLOCKS_PER_SECTION_PUT} blocks per section`, { path: 'blocks', meta: { reason: 'payload_too_large' } });
      }
      const blocks: BlockRow[] = [];
      for (let j = 0; j < body.blocks.length; j++) {
        const [block, issue] = parseBlock(body.blocks[j], `blocks[${j}]`);
        if (issue) return sendError(res, 400, 'VALIDATION_ERROR', issue.message, { path: issue.path, meta: { reason: issue.reason } });
        if (block!.sort_order === 0 && (body.blocks[j] as any)?.sort_order === undefined) block!.sort_order = j;
        blocks.push(block!);
      }

      const { data: section } = await supabase
        .from('sr_sections').select('id, item_id').eq('id', req.params.sectionId).eq('item_id', req.params.itemId).maybeSingle();
      if (!section) return sendError(res, 404, 'NOT_FOUND', 'Section not found in item', { meta: { reason: 'foreign_key_violation' } });

      // reserve the item's slugs OUTSIDE the replaced section so conflicts get
      // a deterministic details.path (the unique index stays the final arbiter)
      const { data: otherBlocks } = await supabase
        .from('sr_blocks').select('slug').eq('item_id', section.item_id).neq('section_id', section.id).not('slug', 'is', null);
      const reserved = new Set<string>((otherBlocks ?? []).map((b: any) => b.slug));

      const preWrite = await preWriteTalkSlugs(supabase, section.item_id);
      const pseudo: SectionInput[] = [{ heading: '', content: null, template_id: null, sort_order: 0, blocks }];
      const blocksIssue = prepareBlocks(pseudo, preWrite, reserved, (_si, bi) => `blocks[${bi}]`);
      if (blocksIssue) {
        const code = blocksIssue.status === 409 ? 'CONFLICT' : blocksIssue.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR';
        return sendError(res, blocksIssue.status ?? 400, code, blocksIssue.message, { path: blocksIssue.path, meta: { reason: blocksIssue.reason } });
      }

      const { error: rpcError } = await supabase.rpc('sr_replace_section_blocks', {
        p_item_id: section.item_id,
        p_section_id: section.id,
        p_blocks: blocks,
        p_expected_version: ifMatch,
      });
      if (rpcError) return sendRpcError(res, rpcError);

      const [{ data: freshItem }, { data: freshBlocks }] = await Promise.all([
        supabase.from('sr_items').select('id, updated_at').eq('id', section.item_id).single(),
        supabase.from('sr_blocks').select(BLOCK_COLUMNS).eq('section_id', section.id),
      ]);
      res.set?.('Cache-Control', 'no-store');
      res.json({
        data: {
          item: { id: freshItem.id, updated_at: serializeItemVersion(freshItem.updated_at) },
          section: { id: section.id },
          blocks: sortBlocks(freshBlocks ?? []),
        },
      });
    } catch (err: any) {
      sendError(res, 500, 'INTERNAL', err?.message ?? 'Internal server error');
    }
  });
}
