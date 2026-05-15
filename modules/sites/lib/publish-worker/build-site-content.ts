/**
 * buildSiteContentFiles — page walker that assembles the file map
 * written to the publish branch on each publish.
 *
 * For each page belonging to the site:
 *   - composition_mode='schema' → writes content/pages/<slug>.json
 *     containing pages.content JSONB
 *   - composition_mode='blocks' → assembles content/pages/<slug>.json
 *     from page_blocks rows (with kind_config + content) ordered by
 *     sort_order; runs build-time fetchers for gatewaze-internal blocks
 *     (freshness=build-time) and ai-generated blocks (cadence=before-publish)
 *
 * Returns a Map<relativePath, contents> suitable for InternalGitServer.publishCommit.
 *
 * Per spec §6.2 + §9.3 build pipeline rows.
 */

interface PageRow {
  id: string;
  slug: string;
  full_path: string;
  composition_mode: 'schema' | 'blocks';
  content: Record<string, unknown> | null;
  status: string;
}

interface PageBlockRow {
  id: string;
  page_id: string;
  block_def_id: string;
  sort_order: number;
  content: Record<string, unknown>;
  kind_config: Record<string, unknown> | null;
}

interface BlockDefRow {
  id: string;
  name: string;
  block_kind: 'static' | 'ai-generated' | 'gatewaze-internal' | 'user-personalized' | 'external-fetched' | 'embed' | 'computed';
  audience: 'public' | 'authenticated' | 'authenticated_optional';
  freshness: 'live' | 'build-time' | null;
  component_export_path: string | null;
  kind_attributes?: Record<string, string>;
}

export interface BuildSiteContentDeps {
  /**
   * Why `any` on `from()`: see internal-git-server-impl.ts dep comment —
   * the OSS modules workspace doesn't ship generated Database types.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any };
  /**
   * Optional source-provider lookup. Called for gatewaze-internal blocks
   * with freshness='build-time' to pre-fetch results into the published
   * content. When omitted (or returns null), the block's kind_config is
   * inlined as-is and the runtime resolves at SSR time.
   */
  fetchSourceData?: (sourceSlug: string, kindConfig: unknown) => Promise<unknown[]>;
  /**
   * Optional AI generator. Called for ai-generated blocks with
   * cadence='before-publish' (or 'manual' since-stale) to generate fresh
   * content before publish. Returns the generated text/json which replaces
   * the block's content. When omitted, the existing content is reused.
   */
  generateAiContent?: (prompt: string, model: string, context: Record<string, unknown>) => Promise<Record<string, unknown>>;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export async function buildSiteContentFiles(
  siteId: string,
  pageSlugFilter: string[] | undefined,
  deps: BuildSiteContentDeps,
): Promise<Map<string, Buffer | string>> {
  const files = new Map<string, Buffer | string>();

  // 1. Fetch all published pages (filtered by slug if requested)
  let pagesQuery = deps.supabase
    .from('pages')
    .select('id, slug, full_path, composition_mode, content, status')
    .eq('host_kind', 'site').eq('host_id', siteId).eq('status', 'published');
  if (pageSlugFilter && pageSlugFilter.length > 0) {
    pagesQuery = pagesQuery.in('slug', pageSlugFilter);
  }
  const pagesResult = await pagesQuery;
  const pages = (pagesResult.data as PageRow[]) ?? [];

  if (pages.length === 0) {
    deps.logger.info('build-site-content: no published pages', { siteId });
    return files;
  }

  // 2. Per-page assembly
  const routesIndex: Array<{ slug: string; full_path: string; composition_mode: string }> = [];

  for (const page of pages) {
    routesIndex.push({ slug: page.slug, full_path: page.full_path, composition_mode: page.composition_mode });

    if (page.composition_mode === 'schema') {
      // Schema-mode: content lives in pages.content JSONB. Plus any
      // editor-authored `page_variants` rows are embedded as a sibling
      // `__variants` map so the runtime resolver (or the theme's local
      // resolver) can pick the right overlay per request.
      //
      // Per spec-aaif-theme-deliverable §7.4: the static JSON is the
      // source of truth. The runtime API reads the SAME file and
      // applies resolution on the server when needed; local resolution
      // in the theme reads the same data and applies the same
      // algorithm. Both paths read variants from the `__variants` key
      // we emit here.
      const variantsResult = await deps.supabase
        .from('page_variants')
        .select('id, field_path, match_context, value, priority, updated_at')
        .eq('page_id', page.id);
      const variantRows = (variantsResult.data as Array<{
        id: string;
        field_path: string;
        match_context: Record<string, unknown>;
        value: unknown;
        priority: number;
        updated_at: string;
      }> | null) ?? [];

      // Group by field_path so the theme can `__variants["heroTitle"]`
      // to find all candidates without scanning the whole list.
      const variantsByField: Record<string, Array<{
        id: string;
        match_context: Record<string, unknown>;
        value: unknown;
        priority: number;
        updated_at: string;
      }>> = {};
      for (const v of variantRows) {
        const arr = variantsByField[v.field_path] ?? [];
        arr.push({
          id: v.id,
          match_context: v.match_context,
          value: v.value,
          priority: v.priority,
          updated_at: v.updated_at,
        });
        variantsByField[v.field_path] = arr;
      }

      const payload: Record<string, unknown> = {
        slug: page.slug,
        full_path: page.full_path,
        composition_mode: 'schema',
        content: page.content ?? {},
      };
      // Only include __variants when there are any — keeps the JSON
      // clean for pages with no personalisation. Theme code can use
      // `data.__variants ?? {}` as a safe fallback.
      if (Object.keys(variantsByField).length > 0) {
        payload['__variants'] = variantsByField;
      }
      files.set(`content/pages/${page.slug}.json`, JSON.stringify(payload, null, 2));
      continue;
    }

    // Blocks-mode: read page_blocks + block_defs, run build-time fetchers
    const blocksResult = await deps.supabase
      .from('page_blocks')
      .select('id, page_id, block_def_id, sort_order, content, kind_config')
      .eq('page_id', page.id)
      .order('sort_order', { ascending: true });
    const blockRows = (blocksResult.data as PageBlockRow[]) ?? [];

    if (blockRows.length === 0) {
      // Empty blocks-mode page — write an empty document
      files.set(`content/pages/${page.slug}.json`, JSON.stringify({
        slug: page.slug,
        full_path: page.full_path,
        composition_mode: 'blocks',
        blocks: [],
      }, null, 2));
      continue;
    }

    // Resolve block definitions
    const blockDefIds = [...new Set(blockRows.map((b) => b.block_def_id))];
    const defsResult = await deps.supabase
      .from('templates_block_defs')
      .select('id, name, block_kind, audience, freshness, component_export_path, kind_attributes')
      .in('id', blockDefIds);
    const defs = (defsResult.data as BlockDefRow[]) ?? [];
    const defById = new Map(defs.map((d) => [d.id, d]));

    // Assemble block instances + run build-time fetchers
    const assembledBlocks: Array<Record<string, unknown>> = [];
    for (const blockRow of blockRows) {
      const def = defById.get(blockRow.block_def_id);
      if (!def) {
        deps.logger.warn('block_def not found at publish time', { blockId: blockRow.id, blockDefId: blockRow.block_def_id });
        continue;
      }

      let resolvedContent = blockRow.content;

      // Build-time fetcher for gatewaze-internal blocks (freshness=build-time)
      if (def.block_kind === 'gatewaze-internal' && def.freshness === 'build-time' && deps.fetchSourceData) {
        const sourceSlug = def.kind_attributes?.source;
        if (sourceSlug) {
          try {
            const data = await deps.fetchSourceData(sourceSlug, blockRow.kind_config ?? {});
            // The block's content schema expects a specific shape; the
            // convention is { ..., events: [...] } / { ..., posts: [...] }
            // — we surface as `data` and let the theme component map.
            resolvedContent = { ...resolvedContent, _source_data: data };
          } catch (err) {
            deps.logger.warn('build-time source fetch failed', {
              source: sourceSlug, blockId: blockRow.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Pre-publish AI generation for ai-generated blocks
      if (def.block_kind === 'ai-generated' && def.kind_attributes?.cadence === 'before-publish' && deps.generateAiContent) {
        const prompt = (blockRow.kind_config as { prompt?: string })?.prompt;
        const model = def.kind_attributes?.model ?? 'claude-sonnet';
        if (prompt) {
          try {
            const generated = await deps.generateAiContent(prompt, model, {
              page_slug: page.slug,
              site_id: siteId,
            });
            resolvedContent = { ...resolvedContent, ...generated };
          } catch (err) {
            deps.logger.warn('ai-generated build-time generation failed', {
              blockId: blockRow.id,
              error: err instanceof Error ? err.message : String(err),
            });
            // Fall back to existing content
          }
        }
      }

      assembledBlocks.push({
        // The page_blocks row id — included so per-block variants (which
        // store their field_path as `<block-id>.<prop>`) can target the
        // right block at theme-resolution time. Per spec-aaif-theme-
        // deliverable §5.2.
        id: blockRow.id,
        block_def_name: def.name,
        block_kind: def.block_kind,
        audience: def.audience,
        component_export_path: def.component_export_path,
        sort_order: blockRow.sort_order,
        content: resolvedContent,
        kind_config: blockRow.kind_config,
      });
    }

    // Variants sidecar — same shape as schema-mode (`__variants[field_path]
    // = candidates[]`). For blocks-mode the field_path is `<block-id>.<prop>`;
    // themes apply via the walkBlockVariants helper at SSR or client time,
    // or fall back to the runtime API for stateful (member-gated) personas.
    const variantsResult = await deps.supabase
      .from('page_variants')
      .select('id, field_path, match_context, value, priority, updated_at')
      .eq('page_id', page.id);
    const variantRows = (variantsResult.data as Array<{
      id: string;
      field_path: string;
      match_context: Record<string, unknown>;
      value: unknown;
      priority: number;
      updated_at: string;
    }> | null) ?? [];

    const variantsByField: Record<string, Array<{
      id: string;
      match_context: Record<string, unknown>;
      value: unknown;
      priority: number;
      updated_at: string;
    }>> = {};
    for (const v of variantRows) {
      const arr = variantsByField[v.field_path] ?? [];
      arr.push({
        id: v.id,
        match_context: v.match_context,
        value: v.value,
        priority: v.priority,
        updated_at: v.updated_at,
      });
      variantsByField[v.field_path] = arr;
    }

    const blocksPayload: Record<string, unknown> = {
      slug: page.slug,
      full_path: page.full_path,
      composition_mode: 'blocks',
      blocks: assembledBlocks,
    };
    if (Object.keys(variantsByField).length > 0) {
      blocksPayload['__variants'] = variantsByField;
    }
    files.set(`content/pages/${page.slug}.json`, JSON.stringify(blocksPayload, null, 2));
  }

  // 3. Routes index — full_path → page slug mapping for the publisher
  files.set('content/routes.json', JSON.stringify(routesIndex, null, 2));

  // 4. Site metadata snapshot (cached at publish time)
  const siteResult = await deps.supabase
    .from('sites')
    .select('slug, name, description, theme_kind, auth_enabled, wrapper_id, config')
    .eq('id', siteId).single();
  if (siteResult.data) {
    files.set('content/site.json', JSON.stringify(siteResult.data, null, 2));
  }

  return files;
}
