/**
 * Runtime content API — the request-time resolution endpoint themes
 * call from their middleware / RSC to get personalized content.
 *
 * Per spec-aaif-theme-deliverable §7 and spec-sites-theme-kinds §7.
 *
 *   GET /api/sites/runtime/content?site=<site_id_or_slug>&route=<full_path>
 *
 * Headers:
 *   Authorization: Bearer <runtime_api_key>
 *   X-Render-Context: base64url(JSON.stringify(renderContext))
 *   X-Preview-Token:  <signed_draft_token>     (optional — draft mode)
 *
 * Response:
 *   {
 *     content: <resolved page content tree>,
 *     applied_context: <subset of context that actually drove resolution>,
 *     resolved_persona: { id, name, label } | null,
 *     cache_hints: { max_age_seconds, vary_axes: string[] }
 *   }
 *
 * Mounted on the PUBLIC router (no JWT) — auth is via the per-site
 * runtime API key. The endpoint never returns admin-only metadata.
 *
 * For AAIF v1 this is the primary read path. Without auth-gated content
 * we could resolve locally in the Next.js theme using the static JSON,
 * but the spec calls for runtime-API-driven resolution to keep the door
 * open for member-gated content + identity-based personalization (§Q2 of
 * the design conversation).
 *
 * Privacy: when variants resolve server-side here, only the WINNING
 * value is transmitted to the client. Variants targeting other personas
 * never leave the API server, so member-gated content can be authored
 * safely.
 */

import type { Request, Response, Router } from 'express';
import { canonicalizeRenderContext, type RenderContextFlat } from '../lib/runtime/render-context.js';
import { walkPageVariants, type PageVariantInput } from '../lib/runtime/walk-page-variants.js';
import { walkBlockVariants, type BlockTreeInput } from '../lib/runtime/walk-block-variants.js';
import {
  resolvePersonaFromContext,
  type StoredPersona,
} from './personas-routes.js';
import { extractBearerKey, hashRuntimeApiKey, compareKeyHashes } from '../lib/runtime/api-keys.js';

interface ErrorEnvelope {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

interface SiteRow {
  id: string;
  slug: string;
}

interface PageRow {
  id: string;
  site_id: string;
  full_path: string;
  composition_mode: string;
  content: Record<string, unknown> | null;
}

interface PageVariantRow {
  id: string;
  field_path: string;
  match_context: Record<string, unknown>;
  value: unknown;
  priority: number;
  updated_at: string;
}

interface RuntimeApiKeyRow {
  key_hash: string;
  site_id: string;
  revoked_at: string | null;
}

export interface RuntimeRoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any };
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** HMAC pepper for API-key hashing. Comes from SITES_RUNTIME_API_PEPPER env. */
  pepper: Uint8Array;
  /** Default cache TTL for non-personalized routes. */
  defaultCacheMaxAgeSeconds?: number;
}

const DEFAULT_CACHE_MAX_AGE_SECONDS = 60;

function paramAs(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return undefined;
}

function sendError(res: Response, status: number, body: ErrorEnvelope): void {
  res.status(status).json(body);
}

export function createRuntimeRoutes(deps: RuntimeRoutesDeps) {
  const { supabase, logger, pepper } = deps;
  const defaultMaxAge = deps.defaultCacheMaxAgeSeconds ?? DEFAULT_CACHE_MAX_AGE_SECONDS;

  async function getContent(req: Request, res: Response): Promise<void> {
    // --- 1. Authenticate via Bearer runtime API key -----------------
    const auth = req.header('authorization') ?? req.header('Authorization');
    const cleartext = extractBearerKey(auth);
    if (!cleartext) {
      sendError(res, 401, { error: 'missing_api_key', message: 'Authorization: Bearer <runtime_api_key> required' });
      return;
    }

    let computedHash: string;
    try {
      computedHash = hashRuntimeApiKey(cleartext, pepper);
    } catch (err) {
      logger.warn('runtime.api_key.hash_failed', { error: err instanceof Error ? err.message : String(err) });
      sendError(res, 401, { error: 'invalid_api_key', message: 'Invalid runtime API key' });
      return;
    }

    const keyLookup = await supabase
      .from('sites_runtime_api_keys')
      .select('key_hash, site_id, revoked_at')
      .eq('key_hash', computedHash)
      .is('revoked_at', null)
      .maybeSingle();

    if (keyLookup.error) {
      logger.warn('runtime.api_key.lookup_failed', { error: String(keyLookup.error.message ?? '') });
      sendError(res, 500, { error: 'internal', message: 'Failed to verify API key' });
      return;
    }
    const keyRow = keyLookup.data as RuntimeApiKeyRow | null;
    if (!keyRow) {
      // Don't tell the caller WHY (revoked vs nonexistent) — opaque 401.
      sendError(res, 401, { error: 'invalid_api_key', message: 'Invalid or revoked runtime API key' });
      return;
    }

    // Constant-time hash comparison as an extra defence (the DB lookup
    // already did the matching, but defence in depth).
    if (!compareKeyHashes(keyRow.key_hash, computedHash)) {
      sendError(res, 401, { error: 'invalid_api_key', message: 'Invalid runtime API key' });
      return;
    }

    // --- 2. Resolve the site -----------------------------------------
    const siteParam = paramAs(req.query.site);
    const routeParam = paramAs(req.query.route);
    if (!siteParam || !routeParam) {
      sendError(res, 400, { error: 'missing_params', message: 'site and route query params required' });
      return;
    }

    // `site` accepts either UUID or slug; if it's a slug, we still
    // verify it belongs to the key's owning site_id to prevent
    // cross-site reads with a stolen key.
    const siteQuery = await supabase
      .from('sites')
      .select('id, slug')
      .or(`id.eq.${siteParam},slug.eq.${siteParam}`)
      .maybeSingle();

    if (siteQuery.error) {
      sendError(res, 500, { error: 'internal', message: String(siteQuery.error.message ?? '') });
      return;
    }
    const site = siteQuery.data as SiteRow | null;
    if (!site) {
      sendError(res, 404, { error: 'site_not_found', message: 'no site matches the given identifier' });
      return;
    }
    if (site.id !== keyRow.site_id) {
      // Key belongs to a different site. Opaque 401 — not 403 — so the
      // caller can't probe site existence with a key from another site.
      sendError(res, 401, { error: 'invalid_api_key', message: 'API key does not own this site' });
      return;
    }

    // --- 3. Parse + canonicalize RenderContext from header -----------
    const rawContextHeader = req.header('x-render-context');
    let context: RenderContextFlat = {};
    if (rawContextHeader && rawContextHeader.length > 0) {
      let decoded: string;
      try {
        decoded = Buffer.from(rawContextHeader, 'base64url').toString('utf-8');
      } catch {
        sendError(res, 400, { error: 'invalid_render_context', message: 'X-Render-Context not valid base64url' });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoded);
      } catch {
        sendError(res, 400, { error: 'invalid_render_context', message: 'X-Render-Context not valid JSON' });
        return;
      }
      const canon = canonicalizeRenderContext(parsed);
      if (!canon.ok) {
        sendError(res, 400, {
          error: 'invalid_render_context',
          message: canon.detail ?? canon.reason,
          details: { reason: canon.reason },
        });
        return;
      }
      context = canon.canonical;
    }

    // --- 4. Resolve persona from context -----------------------------
    const personasRes = await supabase
      .from('site_personas')
      .select('id, name, label, is_default, priority, conditions')
      .eq('site_id', site.id);

    if (personasRes.error) {
      sendError(res, 500, { error: 'internal', message: String(personasRes.error.message ?? '') });
      return;
    }
    const personas = (personasRes.data ?? []) as StoredPersona[];

    const resolved = resolvePersonaFromContext(personas, context);
    const resolvedPersona = resolved
      ? { id: resolved.persona.id, name: resolved.persona.name, label: resolved.persona.label }
      : null;

    // Persona resolution result is folded INTO the context as a
    // canonical `persona` axis, which makes variant resolution dead-
    // simple ("does this variant target persona=X?"). This means a
    // variant authored against persona=enterprise applies regardless of
    // whether the user got there via URL, UTM, or cookie — the persona
    // resolution is the single source of truth.
    if (resolvedPersona) {
      context['persona'] = resolvedPersona.name;
    }

    // --- 5. Load the page + its variants -----------------------------
    const pageQuery = await supabase
      .from('pages')
      .select('id, site_id, full_path, composition_mode, content')
      .eq('site_id', site.id)
      .eq('full_path', routeParam)
      .maybeSingle();

    if (pageQuery.error) {
      sendError(res, 500, { error: 'internal', message: String(pageQuery.error.message ?? '') });
      return;
    }
    const page = pageQuery.data as PageRow | null;
    if (!page) {
      sendError(res, 404, { error: 'page_not_found', message: `no page at ${routeParam}` });
      return;
    }

    const variantsQuery = await supabase
      .from('page_variants')
      .select('id, field_path, match_context, value, priority, updated_at')
      .eq('page_id', page.id);

    if (variantsQuery.error) {
      sendError(res, 500, { error: 'internal', message: String(variantsQuery.error.message ?? '') });
      return;
    }
    const variants = ((variantsQuery.data ?? []) as PageVariantRow[]).map((v) => ({
      id: v.id,
      field_path: v.field_path,
      match_context: v.match_context,
      value: v.value,
      priority: v.priority,
      updated_at: v.updated_at,
    } satisfies PageVariantInput));

    // --- 6. Apply variants -------------------------------------------
    //
    // Two paths depending on composition_mode:
    //   schema → walk `pages.content` JSONB; field_path is a dotted
    //            path inside that JSON tree
    //   blocks → assemble the page_blocks tree + walk it; field_path
    //            is `<block-instance-id>.<prop>`
    // The response wraps the merged content the same way the publish
    // emitter writes it to `content/pages/<slug>.json`, so themes can
    // consume both paths with one parser.
    let resolvedContent: Record<string, unknown>;
    let applied: Record<string, string | null>;
    let consideredCount: number;
    let overlayedCount: number;

    if (page.composition_mode === 'schema') {
      const walked = walkPageVariants({
        defaultContent: (page.content ?? {}) as Record<string, unknown>,
        variants,
        context,
        onWarning: (msg, meta) => logger.warn(msg, { ...meta, page_id: page.id }),
      });
      resolvedContent = walked.content;
      applied = walked.applied;
      consideredCount = walked.considered;
      overlayedCount = walked.overlayed;
    } else if (page.composition_mode === 'blocks') {
      const treeQuery = await loadBlockTree(supabase, page.id);
      if (!treeQuery.ok) {
        sendError(res, 500, { error: 'internal', message: treeQuery.error });
        return;
      }
      const walked = walkBlockVariants({
        tree: treeQuery.tree,
        variants,
        context,
        onWarning: (msg, meta) => logger.warn(msg, { ...meta, page_id: page.id }),
      });
      resolvedContent = blockTreeToResponseShape(walked.tree);
      applied = walked.applied;
      consideredCount = walked.considered;
      overlayedCount = walked.overlayed;
    } else {
      sendError(res, 422, {
        error: 'unsupported_composition_mode',
        message: `page composition_mode=${page.composition_mode} is not supported by the runtime endpoint`,
      });
      return;
    }

    // --- 7. Compute cache hints --------------------------------------
    // The set of axes that actually drove resolution = the axes that
    // appeared in any winning variant's match_context + the persona
    // axis (always, since we always run persona resolution).
    const varyAxes = new Set<string>(['persona']);
    for (const fieldPath of Object.keys(applied)) {
      const variantId = applied[fieldPath];
      if (!variantId) continue;
      const variant = variants.find((v) => v.id === variantId);
      if (!variant) continue;
      for (const axis of Object.keys(variant.match_context)) {
        varyAxes.add(axis);
      }
    }
    // Also include persona conditions' axes — if a condition uses
    // geo.country to decide WHICH persona a request is, that axis
    // varies the response even if no variant targets it directly.
    for (const persona of personas) {
      for (const cond of persona.conditions) {
        if (cond.axis !== '*self_select') varyAxes.add(cond.axis);
      }
    }

    // Trim context to only the axes that mattered. Telemetry-friendly
    // and lets the caller cache by exactly those keys.
    const appliedContext: RenderContextFlat = {};
    for (const axis of varyAxes) {
      const v = context[axis];
      if (v !== undefined) appliedContext[axis] = v;
    }

    // --- 8. Respond ---------------------------------------------------
    res.setHeader(
      'Cache-Control',
      `private, max-age=${defaultMaxAge}, stale-while-revalidate=${defaultMaxAge * 5}`,
    );
    res.setHeader('Vary', 'X-Render-Context, Authorization');
    res.status(200).json({
      content: resolvedContent,
      composition_mode: page.composition_mode,
      applied_context: appliedContext,
      resolved_persona: resolvedPersona,
      cache_hints: {
        max_age_seconds: defaultMaxAge,
        vary_axes: Array.from(varyAxes).sort(),
      },
      // Telemetry counters — useful for the editor's "test resolve" UX
      // and for observability dashboards.
      stats: {
        variants_considered: consideredCount,
        variants_applied: overlayedCount,
      },
    });
  }

  return { getContent };
}

// ---------------------------------------------------------------------------
// blocks-mode tree loading + response shaping
// ---------------------------------------------------------------------------

interface PageBlockDbRow {
  id: string;
  page_id: string;
  block_def_id: string;
  sort_order: number;
  variant_key: string;
  content: Record<string, unknown> | null;
}

interface PageBlockBrickDbRow {
  id: string;
  page_block_id: string;
  brick_def_id: string;
  sort_order: number;
  variant_key: string;
  content: Record<string, unknown> | null;
}

interface BlockDefDbRow {
  id: string;
  key: string;
}

interface BrickDefDbRow {
  id: string;
  key: string;
}

type LoadTreeResult =
  | { ok: true; tree: BlockTreeInput; blockDefById: Map<string, BlockDefDbRow>; brickDefById: Map<string, BrickDefDbRow> }
  | { ok: false; error: string };

async function loadBlockTree(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any },
  pageId: string,
): Promise<LoadTreeResult> {
  const blocksRes = await supabase
    .from('page_blocks')
    .select('id, page_id, block_def_id, sort_order, variant_key, content')
    .eq('page_id', pageId)
    .order('sort_order', { ascending: true });
  if (blocksRes.error) return { ok: false, error: String(blocksRes.error.message ?? '') };
  const blockRows = (blocksRes.data ?? []) as PageBlockDbRow[];

  const blockDefIds = Array.from(new Set(blockRows.map((b) => b.block_def_id)));
  const blockDefById = new Map<string, BlockDefDbRow>();
  if (blockDefIds.length > 0) {
    const defsRes = await supabase
      .from('templates_block_defs')
      .select('id, key')
      .in('id', blockDefIds);
    if (defsRes.error) return { ok: false, error: String(defsRes.error.message ?? '') };
    for (const d of (defsRes.data ?? []) as BlockDefDbRow[]) blockDefById.set(d.id, d);
  }

  const bricksRes = await supabase
    .from('page_block_bricks')
    .select('id, page_block_id, brick_def_id, sort_order, variant_key, content')
    .in('page_block_id', blockRows.map((b) => b.id))
    .order('sort_order', { ascending: true });
  if (bricksRes.error) return { ok: false, error: String(bricksRes.error.message ?? '') };
  const brickRows = (bricksRes.data ?? []) as PageBlockBrickDbRow[];

  const brickDefIds = Array.from(new Set(brickRows.map((b) => b.brick_def_id)));
  const brickDefById = new Map<string, BrickDefDbRow>();
  if (brickDefIds.length > 0) {
    const defsRes = await supabase
      .from('templates_brick_defs')
      .select('id, key')
      .in('id', brickDefIds);
    if (defsRes.error) return { ok: false, error: String(defsRes.error.message ?? '') };
    for (const d of (defsRes.data ?? []) as BrickDefDbRow[]) brickDefById.set(d.id, d);
  }

  const tree: BlockTreeInput = {
    topLevel: blockRows.map((b) => ({
      id: b.id,
      block_def_key: blockDefById.get(b.block_def_id)?.key ?? '',
      variant_key: b.variant_key,
      sort_order: b.sort_order,
      content: b.content ?? {},
    })),
    bricks: brickRows.map((b) => ({
      id: b.id,
      page_block_id: b.page_block_id,
      brick_def_key: brickDefById.get(b.brick_def_id)?.key ?? '',
      variant_key: b.variant_key,
      sort_order: b.sort_order,
      content: b.content ?? {},
    })),
  };
  return { ok: true, tree, blockDefById, brickDefById };
}

/**
 * Convert the variant-resolved block tree to the JSON shape themes
 * receive — mirrors the publish emitter's blocks-mode output so both
 * runtime and build-time consumers parse the same thing.
 */
function blockTreeToResponseShape(tree: {
  topLevel: ReadonlyArray<{ id: string; block_def_key: string; variant_key: string; sort_order: number; content: Record<string, unknown> }>;
  bricks: ReadonlyArray<{ id: string; page_block_id: string; brick_def_key: string; variant_key: string; sort_order: number; content: Record<string, unknown> }>;
}): Record<string, unknown> {
  type Brick = (typeof tree.bricks)[number];
  const bricksByBlock = new Map<string, Brick[]>();
  for (const br of tree.bricks) {
    const arr = bricksByBlock.get(br.page_block_id) ?? [];
    arr.push(br);
    bricksByBlock.set(br.page_block_id, arr);
  }

  return {
    blocks: tree.topLevel.map((b) => {
      const bricks = bricksByBlock.get(b.id);
      const out: Record<string, unknown> = {
        block_def_name: b.block_def_key,
        sort_order: b.sort_order,
        variant_key: b.variant_key,
        content: b.content,
      };
      if (bricks && bricks.length > 0) {
        out.bricks = bricks.map((br) => ({
          brick_def_name: br.brick_def_key,
          sort_order: br.sort_order,
          variant_key: br.variant_key,
          content: br.content,
        }));
      }
      return out;
    }),
  };
}

export function mountRuntimeRoutes(router: Router, routes: ReturnType<typeof createRuntimeRoutes>): void {
  router.get('/sites/runtime/content', routes.getContent);
}
