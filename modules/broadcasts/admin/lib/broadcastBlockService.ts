/**
 * Client-side block service for the broadcast Content step.
 * Per spec-broadcasts-blocks.md §4.2–4.5 / §6.
 *
 * Broadcasts CRUD is client-side (browser supabase client, RLS
 * `auth_all_broadcast_*`), matching the rest of broadcastService.ts — there is
 * no server-side broadcasts admin API. This module owns the block instances
 * (`broadcast_blocks` / `broadcast_bricks`), the module-gated palette query
 * over `templates_block_defs`, legacy-HTML back-compat, and the
 * `broadcast_links` registry sync (link-row upsert; the caller applies
 * `tagHtmlLinks` to the rendered HTML).
 */

import { supabase } from '@/lib/supabase';
import {
  buildBroadcastLinkRows,
  occurrenceKey,
  type BroadcastLinkRow,
} from '../../lib/broadcast-links.js';
import { tagHtmlLinks, type LinkSourceBlock, type TaggableLink } from '../../lib/link-tracking.js';
import { renderBroadcastBody, DEFAULT_BROADCAST_SHELL } from '../../lib/render-broadcast.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A block instance in a broadcast body. */
export interface BroadcastBlock {
  id: string;
  broadcast_id: string;
  templates_block_def_id: string | null;
  block_type: string;
  owner_module: string | null;
  sort_order: number;
  tracking_slug: string | null;
  content: Record<string, unknown>;
  bricks?: BroadcastBrick[];
}

export interface BroadcastBrick {
  id: string;
  block_id: string;
  templates_brick_def_id: string | null;
  brick_type: string;
  sort_order: number;
  content: Record<string, unknown>;
}

/** A block definition available to the palette (subset of templates_block_defs). */
export interface BlockDef {
  id: string;
  key: string;
  name: string;
  description: string | null;
  schema: Record<string, unknown>;
  html: string;
  rich_text_template: string | null;
  has_bricks: boolean;
  render_kind: string;
  component_id: string | null;
  owner_module: string | null;
  required_feature: string | null;
}

export interface PaletteFilter {
  /** The git-managed default broadcast library id (defs are scoped to it +
   *  any module-owned defs). */
  libraryId?: string | null;
  /** Module ids currently enabled on this brand (from the host module registry). */
  enabledModules: ReadonlyArray<string>;
  /** Features the operator holds (from the host feature context). */
  heldFeatures: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Palette — module-gated available defs
// ---------------------------------------------------------------------------

/**
 * Current block-defs offered to this operator. A def is available when it is
 * `is_current` AND (owner_module is NULL — core — OR its module is enabled) AND
 * (required_feature is NULL OR the operator holds it). Filtering happens
 * client-side after fetch so a single query serves all gates; the server-side
 * add-block guard re-validates availability (never trust the palette alone).
 */
export async function listAvailableBlockDefs(filter: PaletteFilter): Promise<BlockDef[]> {
  let query = supabase
    .from('templates_block_defs')
    .select('id, key, name, description, schema, html, rich_text_template, has_bricks, render_kind, component_id, owner_module, required_feature')
    .eq('is_current', true)
    .order('key');
  if (filter.libraryId) query = query.eq('library_id', filter.libraryId);
  const { data, error } = await query;
  if (error) throw error;

  const enabled = new Set(filter.enabledModules);
  const held = new Set(filter.heldFeatures);
  return ((data ?? []) as BlockDef[]).filter((d) => {
    if (d.owner_module && !enabled.has(d.owner_module)) return false;
    if (d.required_feature && !held.has(d.required_feature)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Block CRUD
// ---------------------------------------------------------------------------

const BLOCK_COLS =
  'id, broadcast_id, templates_block_def_id, block_type, owner_module, sort_order, tracking_slug, content, bricks:broadcast_bricks(id, block_id, templates_brick_def_id, brick_type, sort_order, content)';

/** Ordered block instances for a broadcast (with embedded bricks). */
export async function listBlocks(broadcastId: string): Promise<BroadcastBlock[]> {
  const { data, error } = await supabase
    .from('broadcast_blocks')
    .select(BLOCK_COLS)
    .eq('broadcast_id', broadcastId)
    .order('sort_order');
  if (error) throw error;
  const blocks = (data ?? []) as BroadcastBlock[];
  for (const b of blocks) (b.bricks ??= []).sort((x, y) => x.sort_order - y.sort_order);
  return blocks;
}

export interface AddBlockInput {
  templates_block_def_id: string | null;
  block_type: string;
  owner_module?: string | null;
  content?: Record<string, unknown>;
  tracking_slug?: string | null;
  sort_order?: number;
}

/** Append (or insert at sort_order) a block instance. */
export async function addBlock(broadcastId: string, input: AddBlockInput): Promise<BroadcastBlock> {
  const sort_order = input.sort_order ?? (await nextSortOrder(broadcastId));
  const { data, error } = await supabase
    .from('broadcast_blocks')
    .insert({
      broadcast_id: broadcastId,
      templates_block_def_id: input.templates_block_def_id,
      block_type: input.block_type,
      owner_module: input.owner_module ?? null,
      content: input.content ?? {},
      tracking_slug: input.tracking_slug ?? null,
      sort_order,
    })
    .select(BLOCK_COLS)
    .single();
  if (error) throw error;
  return data as BroadcastBlock;
}

export async function updateBlock(
  blockId: string,
  patch: Partial<Pick<BroadcastBlock, 'content' | 'sort_order' | 'tracking_slug'>>,
): Promise<BroadcastBlock> {
  const { data, error } = await supabase
    .from('broadcast_blocks')
    .update(patch)
    .eq('id', blockId)
    .select(BLOCK_COLS)
    .single();
  if (error) throw error;
  return data as BroadcastBlock;
}

export async function deleteBlock(blockId: string): Promise<void> {
  const { error } = await supabase.from('broadcast_blocks').delete().eq('id', blockId);
  if (error) throw error;
}

/** Persist a new order: writes sort_order = array index for each id. */
export async function reorderBlocks(orderedIds: ReadonlyArray<string>): Promise<void> {
  await Promise.all(
    orderedIds.map((id, i) =>
      supabase.from('broadcast_blocks').update({ sort_order: i }).eq('id', id),
    ),
  );
}

async function nextSortOrder(broadcastId: string): Promise<number> {
  const { data } = await supabase
    .from('broadcast_blocks')
    .select('sort_order')
    .eq('broadcast_id', broadcastId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  const top = (data as { sort_order?: number } | null)?.sort_order;
  return typeof top === 'number' ? top + 1 : 0;
}

// ---------------------------------------------------------------------------
// Initial block: auto-seed a core `richtext` block so users can just type
// ---------------------------------------------------------------------------

/**
 * Ensure a broadcast has at least one block when the Content tab first opens.
 * When no blocks exist, insert a single core `richtext` block so the composer
 * lands on a ready-to-type rich-text field (the broadcast body has no complex
 * git wrapper — it's blocks in a simple shell — so a plain rich-text block is
 * the zero-friction starting point). The block is seeded with any legacy
 * `content_json.html` / `rendered_html` from a pre-blocks broadcast (that
 * converts existing rich-text broadcasts into the basic rich-text block), or
 * empty for a brand-new one. Idempotent: does nothing when blocks already
 * exist. Per spec-broadcasts-blocks.md §4.5.
 */
const seedInflight = new Map<string, Promise<BroadcastBlock[]>>();

export async function ensureInitialBlock(
  broadcastId: string,
  legacy?: { content_json?: Record<string, unknown> | null; rendered_html?: string | null },
): Promise<BroadcastBlock[]> {
  // De-dupe concurrent callers (React StrictMode double-invokes mount effects;
  // without this both invocations see zero blocks and each insert one — the
  // "two rich-text blocks" bug). Share a single in-flight promise per broadcast.
  const running = seedInflight.get(broadcastId);
  if (running) return running;

  const run = (async (): Promise<BroadcastBlock[]> => {
    const existing = await listBlocks(broadcastId);
    if (existing.length > 0) {
      // Normalize any legacy bespoke `richtext` blocks (from an earlier build)
      // to the registry `text` block so the canvas renders/edits them.
      const stale = existing.filter((b) => b.block_type === 'richtext');
      if (stale.length > 0) {
        await Promise.all(
          stale.map((b) =>
            supabase
              .from('broadcast_blocks')
              .update({
                block_type: 'text',
                content: { body: (b.content?.html as string) ?? (b.content?.body as string) ?? '' },
              })
              .eq('id', b.id),
          ),
        );
        return listBlocks(broadcastId);
      }
      return existing;
    }

    const legacyHtml =
      (legacy?.content_json && typeof legacy.content_json.html === 'string'
        ? (legacy.content_json.html as string)
        : null) ?? legacy?.rendered_html ?? null;

    // Seed a `text` block — the email-blocks registry's rich-text component
    // (content field `body`). Using a registry block_type means the Puck canvas
    // renders/edits it natively and the edition↔blocks adapter doesn't
    // fail-closed on an unknown type. Empty for a new broadcast; seeded from
    // legacy HTML for a pre-blocks one (so old broadcasts open with their body).
    await addBlock(broadcastId, {
      templates_block_def_id: null, // registry component resolved by block_type
      block_type: 'text',
      owner_module: null,
      content: { body: legacyHtml ?? '' },
      sort_order: 0,
    });
    return listBlocks(broadcastId);
  })();

  seedInflight.set(broadcastId, run);
  try {
    return await run;
  } finally {
    seedInflight.delete(broadcastId);
  }
}

// ---------------------------------------------------------------------------
// Link registry sync (?nlb=)
// ---------------------------------------------------------------------------

/** A block shaped for link extraction (structural subset). */
function toLinkSource(b: BroadcastBlock): LinkSourceBlock {
  return {
    id: b.id,
    block_type: b.block_type,
    content: b.content ?? {},
    sort_order: b.sort_order,
    tracking_slug: b.tracking_slug,
    bricks: (b.bricks ?? []).map((k) => ({
      id: k.id,
      brick_type: k.brick_type,
      content: k.content ?? {},
      sort_order: k.sort_order,
    })),
  };
}

/**
 * Rebuild the `broadcast_links` registry for a broadcast from its current
 * blocks, reusing existing tracking_keys (stable attribution), and return the
 * ordered `taggable` list for the caller to apply to the rendered HTML via
 * `tagHtmlLinks`. Mirrors newsletters' `syncEditionLinkRegistry`:
 *   1. read existing (block_id,field,link_index)→tracking_key
 *   2. buildBroadcastLinkRows (pure) with those keys
 *   3. upsert rows on the occurrence key
 *   4. delete registry rows whose occurrence no longer exists
 */
export async function syncBroadcastLinks(
  broadcastId: string,
  blocks: ReadonlyArray<BroadcastBlock>,
): Promise<TaggableLink[]> {
  const { data: existingRows } = await supabase
    .from('broadcast_links')
    .select('id, block_id, field, link_index, tracking_key')
    .eq('broadcast_id', broadcastId);
  const existing = new Map<string, string>();
  for (const r of (existingRows ?? []) as Array<{ block_id: string; field: string; link_index: number; tracking_key: string }>) {
    existing.set(occurrenceKey(r.block_id, r.field, r.link_index), r.tracking_key);
  }

  const { rows, taggable } = buildBroadcastLinkRows(
    broadcastId,
    blocks.map(toLinkSource),
    existing,
  );

  if (rows.length > 0) {
    const { error } = await supabase
      .from('broadcast_links')
      .upsert(rows as BroadcastLinkRow[], { onConflict: 'block_id,field,link_index' });
    if (error) throw error;
  }

  // Drop registry rows whose occurrence no longer exists in the current body.
  const liveKeys = new Set(rows.map((r) => occurrenceKey(r.block_id, r.field, r.link_index)));
  const stale = ((existingRows ?? []) as Array<{ id: string; block_id: string; field: string; link_index: number }>)
    .filter((r) => !liveKeys.has(occurrenceKey(r.block_id, r.field, r.link_index)))
    .map((r) => r.id);
  if (stale.length > 0) {
    await supabase.from('broadcast_links').delete().in('id', stale);
  }

  return taggable;
}

// ---------------------------------------------------------------------------
// content_json round-trip pointer
// ---------------------------------------------------------------------------

/** The v2 content_json pointer: block order for round-tripping the builder. */
export function buildContentPointer(blocks: ReadonlyArray<BroadcastBlock>): {
  version: 2;
  block_ids: string[];
} {
  return { version: 2, block_ids: [...blocks].sort((a, b) => a.sort_order - b.sort_order).map((b) => b.id) };
}

// ---------------------------------------------------------------------------
// Persist canvas edition → broadcast_blocks (diff upsert)
// ---------------------------------------------------------------------------

/** An edition block as produced by the Puck canvas (structural subset). */
export interface EditionBlockLike {
  id: string;
  block_template?: { id?: string; block_type?: string } | null;
  content?: Record<string, unknown>;
  sort_order?: number;
}

/**
 * Persist the canvas's edited blocks to `broadcast_blocks` (diff: upsert
 * present by id, delete removed). Block ids from the canvas are always UUIDs
 * (edition-puck-adapter's extractStableId), so they map straight onto
 * broadcast_blocks.id. Registry blocks carry block_template.id='' → stored as a
 * NULL templates_block_def_id (the block_type resolves the registry component).
 * Mirrors the newsletters save (handleSave `p_blocks`) minus the RPC.
 */
export async function saveBroadcastEditionBlocks(
  broadcastId: string,
  blocks: ReadonlyArray<EditionBlockLike>,
): Promise<void> {
  const { data: cur, error: curErr } = await supabase
    .from('broadcast_blocks')
    .select('id')
    .eq('broadcast_id', broadcastId);
  if (curErr) throw curErr;
  const currentIds = new Set(((cur ?? []) as Array<{ id: string }>).map((r) => r.id));

  const desired = blocks.map((b, i) => ({
    id: b.id,
    broadcast_id: broadcastId,
    templates_block_def_id: b.block_template?.id ? b.block_template.id : null,
    block_type: b.block_template?.block_type ?? 'text',
    owner_module: null as string | null,
    sort_order: typeof b.sort_order === 'number' ? b.sort_order : (i + 1) * 1000,
    tracking_slug: null as string | null,
    content: b.content ?? {},
  }));

  if (desired.length > 0) {
    const { error } = await supabase.from('broadcast_blocks').upsert(desired, { onConflict: 'id' });
    if (error) throw error;
  }

  const desiredIds = new Set(desired.map((d) => d.id));
  const remove = [...currentIds].filter((id) => !desiredIds.has(id));
  if (remove.length > 0) {
    const { error } = await supabase.from('broadcast_blocks').delete().in('id', remove);
    if (error) throw error;
  }
}

/** Persist the final rendered HTML (+ content pointer) on the broadcast. */
export async function saveRenderedHtml(broadcastId: string, renderedHtml: string): Promise<void> {
  const blocks = await listBlocks(broadcastId);
  const { error } = await supabase
    .from('broadcasts')
    .update({ rendered_html: renderedHtml, content_json: buildContentPointer(blocks) })
    .eq('id', broadcastId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Render + persist (v1 richtext-only path — superseded by the canvas editor,
// kept for non-canvas callers / the event-content bridge fallback)
// ---------------------------------------------------------------------------

export interface RenderSaveResult {
  rendered_html: string;
  /** ids of def-backed blocks not yet rendered by the v1 path (empty-safe). */
  skipped: string[];
}

/**
 * Render the broadcast's current blocks to `rendered_html`, sync the
 * `broadcast_links` registry, tag the HTML with `?nlb=`, and persist both the
 * HTML and the v2 `content_json` pointer on the broadcast. Called on save from
 * the Content step. The send/drip path reads `rendered_html` unchanged.
 *
 * v1 renders the core `richtext` block (verbatim, shelled). Def-backed blocks
 * are skipped here (they render via the canvas react-email path in a later
 * step) and returned in `skipped` so the UI can flag them.
 */
export async function renderAndSave(broadcastId: string): Promise<RenderSaveResult> {
  const blocks = await listBlocks(broadcastId);

  // Sync the link registry from block content (renderer-agnostic) → taggable list.
  const taggable = await syncBroadcastLinks(broadcastId, blocks);

  // Render body → shell, then stamp ?nlb= onto the rendered links.
  const { html: body, skipped } = renderBroadcastBody(
    blocks.map((b) => ({ id: b.id, block_type: b.block_type, sort_order: b.sort_order, content: b.content ?? {} })),
    { shell: DEFAULT_BROADCAST_SHELL },
  );
  const rendered_html = tagHtmlLinks(body, taggable);

  const { error } = await supabase
    .from('broadcasts')
    .update({ rendered_html, content_json: buildContentPointer(blocks) })
    .eq('id', broadcastId);
  if (error) throw error;

  return { rendered_html, skipped };
}
