/**
 * importLfxSite — turns an lfx-mos-website bundle into a gatewaze site.
 *
 *   1. sites row (or reuse by slug when `replace`)
 *   2. templates_libraries row for the site
 *   3. ingest the generated source.html (wrapper + blocks) through the
 *      templates module — same path as "Import from git" in the Source tab
 *   4. run the canvas template validator over every block_def so the
 *      Puck palette lists them (it filters on canvas_validated=true)
 *   5. pages + page_blocks in blocks mode, data-backed blocks filled from
 *      the platform (members, events, news) when a data provider is given
 *
 * Everything the platform owns (git server, HTTP auth, secrets) is kept
 * out of here: the caller passes a service-role Supabase client plus the
 * two templates-module functions. The CLI in scripts/import-lfx-site.ts
 * and the admin route both wire the same function.
 */

import { buildLfxSourceHtml, LFX_BLOCKS, LFX_WRAPPER_KEY } from './theme.js';
import { planPages } from './pages.js';
import { fillBlockContent, resolveFill, LFX_FILL_OPERATION } from './fill.js';
import type { LfxBundle, LfxDataProvider, PlannedPage } from './types.js';

export interface ImportSupabaseClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface IngestInlineFn {
  (
    supabase: ImportSupabaseClient,
    input: { library_id: string; label: string; inline_html: string; created_by?: string | null },
  ): Promise<{
    source_id: string;
    apply: {
      artifacts: ReadonlyArray<{ artifact_kind: string; key: string; action: string; artifact_id?: string }>;
      errors: ReadonlyArray<{ code: string; message: string }>;
    };
  }>;
}

export interface ValidateTemplateFn {
  (input: { html: string; schema: Record<string, unknown>; brickDefKeys: ReadonlyArray<string> }):
    | { valid: true }
    | { valid: false; errors: ReadonlyArray<{ code: string; message: string; detail?: string }> };
}

export interface ImportLfxSiteDeps {
  supabase: ImportSupabaseClient;
  ingestInline: IngestInlineFn;
  validateCanvasTemplate: ValidateTemplateFn;
  /** When omitted, data-backed blocks keep the generator's placeholder rows. */
  dataProvider?: LfxDataProvider | null;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface ImportLfxSiteInput {
  bundle: LfxBundle;
  /** sites.slug — lowercase, [a-z0-9-]. */
  slug: string;
  name?: string;
  description?: string;
  createdBy?: string | null;
  /** Reuse an existing site with this slug: its pages and library are replaced; id, repo and secrets are kept. */
  replace?: boolean;
  /** Pages are created published by default so a publish is one click away. */
  pageStatus?: 'draft' | 'published';
}

export interface ImportLfxSiteResult {
  siteId: string;
  reused: boolean;
  libraryId: string;
  sourceId: string;
  wrapperId: string;
  blockDefs: Array<{ key: string; id: string; valid: boolean; errors: string[] }>;
  pages: Array<{ id: string; slug: string; full_path: string; blockCount: number }>;
  fillErrors: Array<{ page: string; block: string; field: string; message: string }>;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function fail(step: string, error: { message: string } | null | undefined): never {
  throw new Error(`lfx-import ${step}: ${error?.message ?? 'no row returned'}`);
}

/** Bounded string from untrusted JSON, or null. */
function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;
}

function hexColour(v: unknown): string | null {
  return typeof v === 'string' && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v.trim()) ? v.trim().toUpperCase() : null;
}

export async function importLfxSite(deps: ImportLfxSiteDeps, input: ImportLfxSiteInput): Promise<ImportLfxSiteResult> {
  const { supabase } = deps;
  const log = deps.logger ?? { info: () => undefined, warn: () => undefined };
  const { bundle } = input;
  const site = bundle.site;
  if (!SLUG_RE.test(input.slug)) throw new Error(`lfx-import: invalid slug '${input.slug}'`);
  if (!site?.project?.name || !site.pages?.home) throw new Error('lfx-import: site.json is missing project.name or pages.home');

  const name = input.name ?? site.project.name;
  const pageStatus = input.pageStatus ?? 'published';
  const createdBy = input.createdBy ?? null;

  // Derive everything from site.json BEFORE touching the database, so a
  // malformed bundle fails here rather than after the destructive steps.
  const plan = planPages(site);
  const sourceHtml = buildLfxSourceHtml(bundle);
  const domain = String(site.project.domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const lfxConfig = {
    generator: str((site.meta as { generator?: unknown } | undefined)?.generator, 120) ?? 'lfx-mos-website',
    generated_at: str((site.meta as { generated_at?: unknown } | undefined)?.generated_at, 40),
    imported_at: new Date().toISOString(),
    domain: HOSTNAME_RE.test(domain) ? domain : null,
    brand: {
      dark: hexColour(site.brand.dark),
      accent: hexColour(site.brand.accent),
      spark: hexColour(site.brand.spark ?? site.brand.accent),
      font: str(site.brand.font, 80),
    },
  };

  // -- 1. site row ---------------------------------------------------------
  const existing = await supabase
    .from('sites')
    .select('id, templates_library_id, config')
    .eq('slug', input.slug)
    .maybeSingle();
  if (existing.error) fail('lookup site', existing.error);
  const existingRow = existing.data as { id: string; templates_library_id: string | null; config: Record<string, unknown> | null } | null;

  // Merge into whatever config the site already has (analytics, theme,
  // publish flags) rather than replacing it.
  const priorConfig = (existingRow?.config ?? {}) as Record<string, unknown>;
  const priorPublish = (priorConfig.publish ?? {}) as Record<string, unknown>;
  const siteConfig = {
    ...priorConfig,
    publish: { ...priorPublish, output: 'static-html' },
    lfx: lfxConfig,
  };

  let siteId: string;
  let reused = false;
  if (existingRow) {
    if (!input.replace) throw new Error(`lfx-import: site '${input.slug}' already exists (pass replace to reuse it)`);
    reused = true;
    siteId = existingRow.id;
    // Drop the pages first (page_blocks cascade), then the old library
    // (block_defs, wrappers, sources cascade). The site row, its git repo
    // and secrets stay.
    const delPages = await supabase.from('pages').delete().eq('host_kind', 'site').eq('host_id', siteId);
    if (delPages.error) fail('delete pages', delPages.error);
    const unlink = await supabase
      .from('sites')
      .update({ templates_library_id: null, wrapper_id: null, name, description: input.description ?? site.project.description, config: siteConfig })
      .eq('id', siteId);
    if (unlink.error) fail('unlink library', unlink.error);
    const delLib = await supabase.from('templates_libraries').delete().eq('host_kind', 'site').eq('host_id', siteId);
    if (delLib.error) fail('delete library', delLib.error);
    log.info('lfx-import: reusing site', { siteId, slug: input.slug });
  } else {
    const ins = await supabase
      .from('sites')
      .insert({
        slug: input.slug,
        name,
        description: input.description ?? site.project.description,
        status: 'active',
        theme_kind: 'website',
        publishing_target: { kind: 'portal' },
        config: siteConfig,
        created_by: createdBy,
      })
      .select('id')
      .single();
    if (ins.error || !ins.data) fail('insert site', ins.error);
    siteId = (ins.data as { id: string }).id;
    log.info('lfx-import: site created', { siteId, slug: input.slug });
  }

  // -- 2. library ----------------------------------------------------------
  const lib = await supabase
    .from('templates_libraries')
    .insert({
      host_kind: 'site',
      host_id: siteId,
      name: `${name} (LFX theme)`,
      description: `Wrapper and blocks imported from the LFX website builder bundle for ${site.project.name}.`,
      theme_kind: 'website',
    })
    .select('id')
    .single();
  if (lib.error || !lib.data) fail('insert library', lib.error);
  const libraryId = (lib.data as { id: string }).id;

  // -- 3. ingest source.html ----------------------------------------------
  const ingest = await deps.ingestInline(supabase, {
    library_id: libraryId,
    label: 'LFX foundation theme',
    inline_html: sourceHtml,
    created_by: createdBy,
  });
  if (ingest.apply.errors.length > 0) {
    throw new Error(
      'lfx-import: theme ingest failed: ' + ingest.apply.errors.map((e) => `${e.code}: ${e.message}`).join('; '),
    );
  }

  const wrapperRes = await supabase
    .from('templates_wrappers')
    .select('id')
    .eq('library_id', libraryId)
    .eq('key', LFX_WRAPPER_KEY)
    .eq('is_current', true)
    .maybeSingle();
  if (wrapperRes.error || !wrapperRes.data) fail('load wrapper', wrapperRes.error);
  const wrapperId = (wrapperRes.data as { id: string }).id;

  const link = await supabase
    .from('sites')
    .update({ templates_library_id: libraryId, wrapper_id: wrapperId })
    .eq('id', siteId);
  if (link.error) fail('link library', link.error);

  // -- 4. validate block templates for the canvas --------------------------
  interface DefRow { id: string; key: string; html: string; schema: Record<string, unknown>; has_bricks: boolean; data_source: unknown }
  const defsRes = await supabase
    .from('templates_block_defs')
    .select('id, key, html, schema, has_bricks, data_source')
    .eq('library_id', libraryId)
    .eq('is_current', true);
  if (defsRes.error) fail('load block defs', defsRes.error);
  const defs = (defsRes.data as DefRow[]) ?? [];
  const defByKey = new Map(defs.map((d) => [d.key, d]));

  // The apply RPC does not persist the DATA_SOURCE marker's payload, so
  // write the fill config onto the data-backed defs ourselves. Both the
  // import and the publish-time refresh read it from this column.
  const fillByKey = new Map(LFX_BLOCKS.filter((b) => b.fill).map((b) => [b.key as string, b.fill!]));
  for (const d of defs) {
    const fill = fillByKey.get(d.key);
    if (!fill) continue;
    const dataSource = { adapter: 'gatewaze', operation: LFX_FILL_OPERATION, params: fill };
    const upd = await supabase.from('templates_block_defs').update({ data_source: dataSource }).eq('id', d.id);
    if (upd.error) fail(`set data_source on ${d.key}`, upd.error);
    d.data_source = dataSource;
  }

  const blockDefsOut: ImportLfxSiteResult['blockDefs'] = [];
  for (const d of defs) {
    const result = deps.validateCanvasTemplate({ html: d.html, schema: d.schema, brickDefKeys: [] });
    const errors = result.valid ? [] : result.errors.map((e) => `${e.code}${e.detail ? ` (${e.detail})` : ''}: ${e.message}`);
    const upd = await supabase
      .from('templates_block_defs')
      .update({
        canvas_validated: result.valid,
        canvas_validation_errors: result.valid ? null : result.errors.map((e) => ({ code: e.code, message: e.message, detail: e.detail ?? null })),
      })
      .eq('id', d.id);
    if (upd.error) fail(`mark block_def ${d.key}`, upd.error);
    blockDefsOut.push({ key: d.key, id: d.id, valid: result.valid, errors });
    if (!result.valid) log.warn('lfx-import: block template failed canvas validation', { key: d.key, errors });
  }

  // -- 5. pages + blocks ---------------------------------------------------
  const pagesOut: ImportLfxSiteResult['pages'] = [];
  const fillErrors: ImportLfxSiteResult['fillErrors'] = [];
  const idByPath = new Map<string, string>();

  for (const page of plan) {
    const pageId = await insertPage(supabase, { siteId, libraryId, wrapperId, page, pageStatus, createdBy, parentId: page.parent_path ? idByPath.get(page.parent_path) ?? null : null });
    idByPath.set(page.full_path, pageId);

    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < page.blocks.length; i++) {
      const b = page.blocks[i]!;
      const def = defByKey.get(b.key);
      if (!def) throw new Error(`lfx-import: planned block '${b.key}' has no block_def in the ingested library`);

      let content = b.content;
      const kindConfig = b.fill ? { fill: b.fill } : null;
      const fill = resolveFill(def.data_source as { adapter?: string; operation?: string; params?: unknown } | null, kindConfig);
      if (fill && deps.dataProvider) {
        const filled = await fillBlockContent(content, fill, deps.dataProvider);
        content = filled.content;
        for (const e of filled.errors) fillErrors.push({ page: page.full_path, block: b.key, field: e.field, message: e.message });
      }

      rows.push({
        page_id: pageId,
        block_def_id: def.id,
        sort_order: (i + 1) * 1000,
        variant_key: 'default',
        content,
        parent_brick_id: null,
        ...(kindConfig ? { kind_config: kindConfig } : {}),
      });
    }
    if (rows.length > 0) {
      const insBlocks = await supabase.from('page_blocks').insert(rows);
      if (insBlocks.error) fail(`insert blocks for ${page.full_path}`, insBlocks.error);
    }
    pagesOut.push({ id: pageId, slug: page.slug, full_path: page.full_path, blockCount: rows.length });
  }

  log.info('lfx-import: done', { siteId, libraryId, pages: pagesOut.length, blockDefs: defs.length });
  return {
    siteId,
    reused,
    libraryId,
    sourceId: ingest.source_id,
    wrapperId,
    blockDefs: blockDefsOut,
    pages: pagesOut,
    fillErrors,
  };
}

async function insertPage(
  supabase: ImportSupabaseClient,
  args: {
    siteId: string;
    libraryId: string;
    wrapperId: string;
    page: PlannedPage;
    pageStatus: 'draft' | 'published';
    createdBy: string | null;
    parentId: string | null;
  },
): Promise<string> {
  const { page } = args;
  const seo: Record<string, unknown> = {};
  if (page.seo.title) seo.title = page.seo.title;
  if (page.seo.description) seo.description = page.seo.description;
  const res = await supabase
    .from('pages')
    .insert({
      host_kind: 'site',
      host_id: args.siteId,
      templates_library_id: args.libraryId,
      parent_page_id: args.parentId,
      slug: page.slug,
      full_path: page.full_path,
      title: page.title,
      status: args.pageStatus,
      seo,
      is_homepage: page.is_homepage,
      composition_mode: 'blocks',
      wrapper_id: args.wrapperId,
      content: {},
      content_schema_version: null,
      // The canvas is the only editor for these pages; the publish-worker
      // rejects hand edits to content/pages/<slug>.json.
      wysiwyg_locked: true,
      created_by: args.createdBy,
    })
    .select('id')
    .single();
  if (res.error || !res.data) fail(`insert page ${page.full_path}`, res.error);
  return (res.data as { id: string }).id;
}
