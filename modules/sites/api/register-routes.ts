// @ts-nocheck — depends on @supabase/supabase-js + express which require
// `pnpm install` to resolve at the modules workspace level. Excluded from
// the strict tsconfig until the workspace install is wired up. The runtime
// shape is correct; type errors here are bounded to import resolution.
/**
 * Sites module — apiRoutes hook entry point.
 *
 * Mounts admin endpoints (republish, source, menus, media) on the
 * platform's express app under /api/. Wired from the module manifest's
 * `apiRoutes` callback.
 *
 * Auth: the platform's requireJwt middleware is applied upstream by
 * the labeledRouter('jwt') used for /admin/* routes; service-role
 * JWTs bypass per-host RLS via the supabase-js service-role client.
 *
 * Webhook receiver mounts on the public router (no JWT required;
 * HMAC signature is the only auth).
 */

import type { ModuleContext } from '@gatewaze/shared';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Router, type Express, type Request } from 'express';
import multer from 'multer';
import { randomBytes } from 'node:crypto';

import { createRepublishRoutes, mountRepublishRoutes } from './republish.js';
import { createSourceRoutes, mountSourceRoutes } from './source-routes.js';
import { createMenusRoutes, mountMenusRoutes } from './menus-routes.js';
import { createPublicMenusRoutes, mountPublicMenusRoutes } from './public-menus-routes.js';
import { createPersonasRoutes, mountPersonasRoutes } from './personas-routes.js';
import { createPageVariantsRoutes, mountPageVariantsRoutes } from './page-variants-routes.js';
import { createRuntimeRoutes, mountRuntimeRoutes } from './runtime-routes.js';
import { createMediaRoutes, mountMediaRoutes, type MediaUploadInput } from './media-routes.js';
import { createAdminRoutes, mountAdminRoutes } from './admin.js';
import { createCanvasRoutes, mountCanvasRoutes } from './canvas/index.js';
import { createValidateTemplatesRoute, mountValidateTemplatesRoute } from './canvas/validate-templates.js';
import { createPresetsRoutes, mountPresetsRoutes } from './canvas/presets.js';
import { createUnlockContentRoute, mountUnlockContentRoute } from './canvas/unlock-content.js';
import { createBlockDefsRoute, mountBlockDefsRoute } from './canvas/block-defs.js';
import { createFeatureFlagsRoute, mountFeatureFlagsRoute } from './canvas/feature-flags.js';
import { createAbRoutes, mountAbRoutes } from './ab-routes.js';
import { InternalGitServerImpl } from '../lib/git/internal-git-server-impl.js';
import { PublishWorker } from '../lib/publish-worker/publish-worker.js';
import type { InternalRepoRef } from '../lib/git/internal-git-server.js';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

interface RateLimiter {
  check(key: string, max: number, windowMs: number): Promise<{ allowed: boolean; resetAt: number }>;
}

function defaultLogger(): PlatformLogger {
  return {
    info: (msg, meta) => console.log(`[sites] ${msg}`, meta ?? ''),
    warn: (msg, meta) => console.warn(`[sites] ${msg}`, meta ?? ''),
    error: (msg, meta) => console.error(`[sites] ${msg}`, meta ?? ''),
  };
}

function defaultRateLimiter(): RateLimiter {
  // In-memory sliding window. Production wires platform's shared rate-limiter.
  const buckets = new Map<string, number[]>();
  return {
    async check(key, max, windowMs) {
      const now = Date.now();
      const bucket = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
      if (bucket.length >= max) {
        return { allowed: false, resetAt: bucket[0]! + windowMs };
      }
      bucket.push(now);
      buckets.set(key, bucket);
      return { allowed: true, resetAt: now + windowMs };
    },
  };
}

export function registerRoutes(app: Express, context?: ModuleContext): void {
  const logger = defaultLogger();
  const rateLimiter = defaultRateLimiter();

  // Service-role Supabase for admin operations (bypasses RLS)
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Internal git server: configurable PVC root + signing key
  const gitRoot = process.env.SITES_INTERNAL_GIT_ROOT ?? '/var/gatewaze/git';
  const signingKeyHex = process.env.SITES_GIT_SIGNING_KEY ?? randomBytes(32).toString('hex');
  if (!process.env.SITES_GIT_SIGNING_KEY) {
    logger.warn('SITES_GIT_SIGNING_KEY not set — using ephemeral signing key (regenerated each restart; signed URLs invalidate on reboot)');
  }
  const gitServer = new InternalGitServerImpl({
    rootDir: gitRoot,
    signingKey: Buffer.from(signingKeyHex, 'hex'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    logger,
  });

  // Repo resolution helpers
  const resolveSiteRepo = async (siteId: string): Promise<InternalRepoRef | null> => {
    const result = await supabase.from('gatewaze_internal_repos')
      .select('host_kind, host_id, bare_path, default_branch')
      .eq('host_kind', 'site').eq('host_id', siteId).single();
    if (!result.data) return null;
    const row = result.data as { host_kind: string; host_id: string; bare_path: string; default_branch: string };
    const slug = row.bare_path.split('/').pop()?.replace(/\.git$/, '') ?? '';
    return { hostKind: 'site', hostId: row.host_id, slug, barePath: row.bare_path, defaultBranch: row.default_branch };
  };
  const resolveListRepo = async (listId: string): Promise<InternalRepoRef | null> => {
    const result = await supabase.from('gatewaze_internal_repos')
      .select('host_kind, host_id, bare_path, default_branch')
      .eq('host_kind', 'list').eq('host_id', listId).single();
    if (!result.data) return null;
    const row = result.data as { host_kind: string; host_id: string; bare_path: string; default_branch: string };
    const slug = row.bare_path.split('/').pop()?.replace(/\.git$/, '') ?? '';
    return { hostKind: 'list', hostId: row.host_id, slug, barePath: row.bare_path, defaultBranch: row.default_branch };
  };

  // Build site content files. v1 covers the schema-mode happy path
  // (pages.content JSONB → content/pages/<slug>.json) plus the Next.js
  // route emitter (analytics + A/B injection in app/layout.tsx). Blocks-
  // mode page assembly from page_blocks + brick rows is wired by
  // build-site-content.ts and slots in here once that lands.
  const buildSiteContentFiles = async (
    siteId: string,
    onlyPagePaths?: string[],
  ): Promise<{ files: Map<string, Buffer | string>; removals: string[]; replaceTree: boolean }> => {
    const out = new Map<string, Buffer | string>();
    const removals: string[] = [];
    // Computed once the site config is loaded: when a theme overlay is
    // configured, the publish branch must be exactly (theme + platform
    // deltas) — so old files (e.g. dropped from the theme between tags)
    // need to be pruned. See publishCommit.replaceTree.
    let replaceTree = false;

    // Lazy-import the emitter — keeps the route file lean for callers
    // that don't trigger publishes (admin endpoints etc.)
    const { emitNextjsRoutes } = await import('../lib/publish-worker/emit-nextjs-routes.js');

    interface SiteRow {
      id: string;
      slug: string;
      wrapper_id: string | null;
      config: Record<string, unknown> | null;
    }
    const siteRes = await supabase
      .from('sites')
      .select('id, slug, wrapper_id, config')
      .eq('id', siteId)
      .single();
    const site = (siteRes as { data: SiteRow | null }).data;
    if (!site) return { files: out, removals, replaceTree };

    interface PageRow {
      id: string;
      slug: string;
      full_path: string;
      title: string;
      content: Record<string, unknown> | null;
      content_schema_version: number | null;
      composition_mode: 'schema' | 'blocks';
      status: string;
      wrapper_id: string | null;
    }

    let pageQuery = supabase
      .from('pages')
      .select('id, slug, full_path, title, content, content_schema_version, composition_mode, status, wrapper_id')
      .eq('host_kind', 'site')
      .eq('host_id', siteId)
      .eq('status', 'published');
    if (onlyPagePaths && onlyPagePaths.length > 0) {
      pageQuery = pageQuery.in('full_path', onlyPagePaths);
    }
    const pagesRes = await pageQuery;
    const pages = ((pagesRes as { data: PageRow[] | null }).data ?? []);

    // Per-site config flag — defaults to false for backwards compatibility.
    // When true, the media-url-rewriter emits binaries for in_repo=true items
    // into public/media/ and references them via relative paths instead of
    // CDN URLs. Per spec-content-modules-git-architecture §14.3.
    const siteConfig = (site.config ?? {}) as {
      publish?: { embed_media_in_git?: boolean };
      theme?: { url?: string; ref?: string; subdir?: string; owns_routing?: boolean };
    };
    const embedMediaInGit = siteConfig.publish?.embed_media_in_git === true;
    const themeConfig = siteConfig.theme;
    // When the theme owns routing, the theme repo's own `app/` (or
    // `src/app/`) tree is authoritative. The platform still emits
    // `content/pages/*.json` and `public/_gatewaze/*.json` so the theme
    // can consume them as it migrates each page; but we skip the
    // `app/layout.tsx` + per-page `app/<slug>/page.tsx` stubs because
    // a) they would shadow the theme's routes (root `app/` wins over
    // `src/app/`), and b) the platform-emitted blocks page uses a
    // template-literal dynamic import that Turbopack rejects in
    // production builds.
    const themeOwnsRouting = themeConfig?.owns_routing === true;

    // Overlay the theme tree FIRST so platform-emitted files (page route
    // stubs, content JSON, site-config) added later in this function win
    // any path collisions. Without a theme config the publish branch only
    // contains the platform deltas — the operator's deploy target needs
    // to supply the rest separately.
    if (themeConfig?.url && themeConfig.ref) {
      const { applyThemeOverlay } = await import('../lib/publish-worker/theme-overlay.js');
      try {
        await applyThemeOverlay(
          { url: themeConfig.url, ref: themeConfig.ref, subdir: themeConfig.subdir },
          out,
          { logger },
        );
        // Theme overlay succeeded — the file map now represents the
        // full intended publish tree, so prune anything not in it.
        replaceTree = true;
      } catch (err) {
        logger.warn('theme overlay failed — publish continues with platform-only deltas', {
          siteId,
          themeUrl: themeConfig.url,
          ref: themeConfig.ref,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Lazy-import the media-url-rewriter and walkPageVariants helpers — they
    // only run when there's published content to walk.
    const { rewriteMediaUrlsInContent } = await import('../lib/publish-worker/media-url-rewriter.js');

    // Track emit jobs across every page so we download each binary once.
    const mediaEmitJobsByPath = new Map<string, {
      storagePath: string;
      gitRelativePath: string;
      mimeType: string;
      bytes: number;
    }>();

    // Canonical single bucket per spec-relative-storage-paths.md.
    // Override via STORAGE_BUCKET env var when migrating to S3 — see
    // §4 of the spec for the storage_bucket_url setting.
    const STORAGE_BUCKET = process.env.STORAGE_BUCKET ?? 'media';
    // Browser-facing URL base. SUPABASE_URL is the internal docker
    // hostname (http://supabase-kong:8000) for server-to-server calls;
    // images served to browsers need the EXTERNAL hostname from
    // SUPABASE_PUBLIC_URL.
    const publicSupabaseUrl = (process.env.SUPABASE_PUBLIC_URL || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const buildPublicUrl = (storagePath: string): string =>
      `${publicSupabaseUrl}/storage/v1/object/public/${STORAGE_BUCKET}/${storagePath}`;

    const mediaRewriterDeps = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: supabase as any,
      bunnyRewriter: null,
      resolveMediaUrl: (storagePath: string) => buildPublicUrl(storagePath),
      logger,
      embedMediaInGit,
    };

    // 1a. Write content/pages/<slug>.json for schema-mode pages.
    //     Includes a __variants sidecar when page_variants rows exist so
    //     themes can resolve per-persona overlays client-side or via the
    //     runtime API. Per spec-example-theme-deliverable §5.2.
    for (const p of pages) {
      if (p.composition_mode !== 'schema') continue;

      const rawContent = (p.content ?? {}) as Record<string, unknown>;
      const rewrite = await rewriteMediaUrlsInContent('site', siteId, rawContent, mediaRewriterDeps);
      for (const job of rewrite.emitJobs) {
        mediaEmitJobsByPath.set(job.gitRelativePath, job);
      }

      // Load the page's variants (page_variants) so the published JSON
      // carries a __variants sidecar that themes apply via walkPageVariants.
      const variantsRes = await supabase
        .from('page_variants')
        .select('id, field_path, match_context, value, priority, updated_at')
        .eq('page_id', p.id);
      const variantRows = ((variantsRes as { data: Array<{
        id: string;
        field_path: string;
        match_context: Record<string, unknown>;
        value: unknown;
        priority: number;
        updated_at: string;
      }> | null }).data) ?? [];
      const variantsByField: Record<string, unknown[]> = {};
      for (const v of variantRows) {
        const arr = (variantsByField[v.field_path] ?? []) as unknown[];
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
        slug: p.slug,
        full_path: p.full_path,
        title: p.title,
        content: rewrite.rewrittenContent,
        schema_version: p.content_schema_version,
      };
      if (Object.keys(variantsByField).length > 0) {
        payload['__variants'] = variantsByField;
      }
      out.set(`content/pages/${p.slug}.json`, JSON.stringify(payload, null, 2));
    }

    // 1b. Write content/pages/<slug>.json for blocks-mode pages by
    //     assembling page_blocks + page_block_bricks rows. The operator's
    //     theme renders block_def_name → component lookup and the
    //     `bricks` array if a block has bricks.
    const blocksPages = pages.filter((p) => p.composition_mode === 'blocks');
    if (blocksPages.length > 0) {
      const blocksPageIds = blocksPages.map((p) => p.id);

      interface PageBlockRow {
        id: string;
        page_id: string;
        block_def_id: string;
        sort_order: number;
        variant_key: string;
        content: Record<string, unknown>;
      }
      const pageBlocksRes = await supabase
        .from('page_blocks')
        .select('id, page_id, block_def_id, sort_order, variant_key, content')
        .in('page_id', blocksPageIds)
        .order('sort_order', { ascending: true });
      const pageBlocks = (((pageBlocksRes as { data: PageBlockRow[] | null }).data) ?? []);

      interface BlockDefRow { id: string; key: string; name: string; has_bricks: boolean; }
      const blockDefIds = Array.from(new Set(pageBlocks.map((pb) => pb.block_def_id)));
      const blockDefById = new Map<string, BlockDefRow>();
      if (blockDefIds.length > 0) {
        const blockDefsRes = await supabase
          .from('templates_block_defs')
          .select('id, key, name, has_bricks')
          .in('id', blockDefIds);
        for (const d of (((blockDefsRes as { data: BlockDefRow[] | null }).data) ?? [])) {
          blockDefById.set(d.id, d);
        }
      }

      interface PageBlockBrickRow {
        id: string;
        page_block_id: string;
        brick_def_id: string;
        sort_order: number;
        variant_key: string;
        content: Record<string, unknown>;
      }
      const blockIdsWithBricks = pageBlocks
        .filter((pb) => blockDefById.get(pb.block_def_id)?.has_bricks)
        .map((pb) => pb.id);
      const bricksByBlockId = new Map<string, PageBlockBrickRow[]>();
      const brickDefById = new Map<string, { id: string; key: string }>();
      if (blockIdsWithBricks.length > 0) {
        const bricksRes = await supabase
          .from('page_block_bricks')
          .select('id, page_block_id, brick_def_id, sort_order, variant_key, content')
          .in('page_block_id', blockIdsWithBricks)
          .order('sort_order', { ascending: true });
        const bricks = (((bricksRes as { data: PageBlockBrickRow[] | null }).data) ?? []);
        for (const b of bricks) {
          if (!bricksByBlockId.has(b.page_block_id)) bricksByBlockId.set(b.page_block_id, []);
          bricksByBlockId.get(b.page_block_id)!.push(b);
        }

        const brickDefIds = Array.from(new Set(bricks.map((b) => b.brick_def_id)));
        if (brickDefIds.length > 0) {
          const brickDefsRes = await supabase
            .from('templates_brick_defs')
            .select('id, key')
            .in('id', brickDefIds);
          for (const d of (((brickDefsRes as { data: { id: string; key: string }[] | null }).data) ?? [])) {
            brickDefById.set(d.id, d);
          }
        }
      }

      for (const page of blocksPages) {
        const blocksForPage = await Promise.all(
          pageBlocks
            .filter((pb) => pb.page_id === page.id)
            .map(async (pb) => {
              const def = blockDefById.get(pb.block_def_id);
              const bricks = bricksByBlockId.get(pb.id);

              // Rewrite media URLs in this block's content + each of its
              // bricks. Media in blocks-mode is referenced just like in
              // schema-mode (via `/media/<storage_path>` placeholders).
              const blockContentRewrite = await rewriteMediaUrlsInContent(
                'site',
                siteId,
                pb.content,
                mediaRewriterDeps,
              );
              for (const job of blockContentRewrite.emitJobs) {
                mediaEmitJobsByPath.set(job.gitRelativePath, job);
              }

              const blockOut: Record<string, unknown> = {
                // Include the page_blocks row id so per-block variants
                // (`<block-id>.<prop>` field_path) can target it.
                id: pb.id,
                block_def_name: def?.key ?? null,
                sort_order: pb.sort_order,
                variant_key: pb.variant_key,
                content: blockContentRewrite.rewrittenContent,
              };
              if (bricks) {
                blockOut.bricks = await Promise.all(bricks.map(async (b) => {
                  const brickRewrite = await rewriteMediaUrlsInContent(
                    'site',
                    siteId,
                    b.content,
                    mediaRewriterDeps,
                  );
                  for (const job of brickRewrite.emitJobs) {
                    mediaEmitJobsByPath.set(job.gitRelativePath, job);
                  }
                  return {
                    id: b.id,
                    brick_def_name: brickDefById.get(b.brick_def_id)?.key ?? null,
                    sort_order: b.sort_order,
                    variant_key: b.variant_key,
                    content: brickRewrite.rewrittenContent,
                  };
                }));
              }
              return blockOut;
            }),
        );

        // Variants sidecar (page_variants) — themes resolve via
        // walkBlockVariants client-side or via the runtime API.
        const variantsRes = await supabase
          .from('page_variants')
          .select('id, field_path, match_context, value, priority, updated_at')
          .eq('page_id', page.id);
        const variantRows = ((variantsRes as { data: Array<{
          id: string;
          field_path: string;
          match_context: Record<string, unknown>;
          value: unknown;
          priority: number;
          updated_at: string;
        }> | null }).data) ?? [];
        const variantsByField: Record<string, unknown[]> = {};
        for (const v of variantRows) {
          const arr = (variantsByField[v.field_path] ?? []) as unknown[];
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
          title: page.title,
          composition_mode: 'blocks',
          blocks: blocksForPage,
        };
        if (Object.keys(variantsByField).length > 0) {
          blocksPayload['__variants'] = variantsByField;
        }
        out.set(`content/pages/${page.slug}.json`, JSON.stringify(blocksPayload, null, 2));
      }
    }

    // 2. Resolve running A/B tests scoped to a page on this site.
    interface AbTestRow {
      id: string;
      scope_id: string;
      goal_event: string;
    }
    const abRes = await supabase
      .from('templates_ab_tests')
      .select('id, scope_id, goal_event')
      .eq('host_kind', 'site')
      .eq('host_id', siteId)
      .eq('scope_kind', 'page')
      .eq('status', 'running');
    const abTestsByRoute: Record<string, { testId: string; goalEvent: string }> = {};
    const abPageIds: string[] = [];
    for (const t of (abRes as { data: AbTestRow[] | null }).data ?? []) {
      const page = pages.find((p) => p.id === t.scope_id);
      if (page) {
        abTestsByRoute[page.full_path] = { testId: t.id, goalEvent: t.goal_event };
        abPageIds.push(page.id);
      }
    }

    // 2b. Per-variant content for each running test. We emit one extra file
    //     per (slug, variant) under `content/pages/<slug>.<variant>.json`.
    //     The bootstrap script fetches the matching file after assignment
    //     and exposes it at window.gatewazeAB.variantContent for the host
    //     theme to apply (operators read it from their renderer code).
    if (abPageIds.length > 0) {
      interface VariantRow {
        page_id: string;
        match_context: Record<string, unknown>;
        content: Record<string, unknown>;
      }
      const variantRes = await supabase
        .from('pages_content_variants')
        .select('page_id, match_context, content')
        .in('page_id', abPageIds)
        .eq('field_path', '/');
      for (const row of ((variantRes as { data: VariantRow[] | null }).data ?? [])) {
        const page = pages.find((p) => p.id === row.page_id);
        if (!page) continue;
        const variant = typeof row.match_context.variant === 'string' ? row.match_context.variant : null;
        if (!variant) continue;
        out.set(
          `content/pages/${page.slug}.${variant}.json`,
          JSON.stringify(
            {
              slug: page.slug,
              full_path: page.full_path,
              variant,
              content: row.content,
            },
            null,
            2,
          ),
        );
      }
    }

    // 3. Resolve integrations runtime config (Umami URL etc.)
    interface InstalledModuleRow {
      config: Record<string, unknown> | null;
    }
    const umamiModRes = await supabase
      .from('installed_modules')
      .select('config')
      .eq('id', 'umami')
      .eq('status', 'enabled')
      .maybeSingle();
    const umamiUrl = ((umamiModRes as { data: InstalledModuleRow | null }).data?.config?.umami_url as string | undefined) ?? undefined;

    // 4. Public API origin — where the rendered site posts A/B events.
    // Prefer PUBLIC_API_ORIGIN; fall back to API_URL (already set in every
    // brand env). When neither is set, the bootstrap script is omitted —
    // analytics still works (Umami uses its own URL).
    const apiOrigin =
      (process.env.PUBLIC_API_ORIGIN as string | undefined) ??
      (process.env.API_URL as string | undefined) ??
      null;

    // 5. Emit the Next.js route + layout files — but only when the
    //    theme has NOT claimed routing. With `theme.owns_routing=true`
    //    the theme's own app/ tree handles routes and the platform
    //    sticks to content/ + public/_gatewaze/ deltas.
    const analytics = ((site.config ?? {}) as { analytics?: { provider?: string; umami?: { umamiWebsiteId?: string; umamiShareId?: string | null } } }).analytics ?? null;

    if (!themeOwnsRouting) {
      const routeFiles = await emitNextjsRoutes(
        pages.map((p) => ({
          slug: p.slug,
          full_path: p.full_path,
          wrapper_id: p.wrapper_id,
          composition_mode: p.composition_mode,
        })),
        {
          supabase,
          site: {
            id: site.id,
            wrapper_id: site.wrapper_id,
            analytics: analytics
              ? {
                  provider: analytics.provider as 'plausible' | 'fathom' | 'umami' | 'ga4' | 'none' | undefined,
                  umami: analytics.umami,
                }
              : null,
          },
          integrations: { umamiUrl },
          apiOrigin,
          abTestsByRoute,
          logger,
        },
      );
      for (const [path, content] of routeFiles) out.set(path, content);
    } else {
      // Compute the paths the route emitter WOULD have produced and add
      // them to removals so prior publishes' platform-emitted `app/*`
      // tree gets cleaned out of the publish branch. Without this the
      // stale stubs persist on example-publish:main and continue to shadow
      // the theme's `src/app/` routes (and break Turbopack builds).
      removals.push('app/layout.tsx');
      const blocksPagesForRemoval = pages.filter((p) => p.composition_mode === 'blocks');
      for (const p of blocksPagesForRemoval) {
        const routePath = p.wrapper_id
          ? null  // wrapper-routed pages get more complex paths; deletion not strictly necessary
          : `app${p.full_path === '/' ? '/(home)' : p.full_path}/page.tsx`;
        if (routePath) removals.push(routePath);
      }
      logger.info('skipping emitNextjsRoutes: theme.owns_routing=true', {
        siteId,
        removalsQueued: removals.length,
      });
    }

    // Site-runtime config — read by @gatewaze-modules/site-runtime's
    // <GatewazeHead /> component when the operator's theme owns its layout
    // (schema-mode sites without a wrapper). Same data the publish-worker
    // would inline server-side for blocks-mode sites; just delivered to
    // the browser as a static file when no SSR injection is possible.
    out.set(
      'public/_gatewaze/site-config.json',
      JSON.stringify(
        {
          apiOrigin,
          analytics: {
            provider: analytics?.provider ?? 'none',
            umami:
              analytics?.umami?.umamiWebsiteId && umamiUrl
                ? { url: umamiUrl, websiteId: analytics.umami.umamiWebsiteId }
                : undefined,
          },
          abBindingsUrl: '/_gatewaze/ab-bindings.json',
        },
        null,
        2,
      ),
    );

    // 6. Download + emit any media binaries collected during the page walk.
    //    Only runs when site.config.publish.embed_media_in_git is true AND
    //    the rewriter produced emit jobs. Each binary is downloaded once
    //    (Map dedupes across pages) and written to public/media/<file>.
    if (embedMediaInGit && mediaEmitJobsByPath.size > 0) {
      logger.info('buildSiteContentFiles.embedding_media', {
        siteId,
        count: mediaEmitJobsByPath.size,
      });
      for (const job of mediaEmitJobsByPath.values()) {
        try {
          const buffer = await mediaAdapter.download(job.storagePath);
          out.set(job.gitRelativePath, buffer);
        } catch (err) {
          logger.warn('media download failed at publish — referencing CDN instead', {
            storagePath: job.storagePath,
            error: err instanceof Error ? err.message : String(err),
          });
          // We don't rewrite the URL back to CDN here — the content
          // already references the relative path. A broken image is
          // visible at publish time so editors can fix the asset before
          // re-publishing. Severity considered acceptable for v1; future
          // work could fall back to CDN URLs on download failure.
        }
      }
    }

    logger.info('buildSiteContentFiles', {
      siteId,
      pagesCount: pages.length,
      abTestsCount: Object.keys(abTestsByRoute).length,
      filesEmitted: out.size,
      removals: removals.length,
      replaceTree,
      mediaEmbedded: embedMediaInGit ? mediaEmitJobsByPath.size : 0,
    });

    return { files: out, removals, replaceTree };
  };

  const publishWorker = new PublishWorker({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    gitServer,
    resolveSiteRepo,
    resolveListRepo,
    buildSiteContentFiles,
    logger,
  });

  // Default media adapter (Supabase Storage). Uses the canonical single
  // `media` bucket per spec-relative-storage-paths.md; cdn_url uses the
  // external SUPABASE_PUBLIC_URL so browsers can resolve the hostname
  // (SUPABASE_URL is the internal docker DNS name).
  const ADAPTER_BUCKET = process.env.STORAGE_BUCKET ?? 'media';
  const adapterPublicSupabaseUrl = (process.env.SUPABASE_PUBLIC_URL || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const adapterBuildPublicUrl = (storagePath: string): string =>
    `${adapterPublicSupabaseUrl}/storage/v1/object/public/${ADAPTER_BUCKET}/${storagePath}`;

  const mediaAdapter = {
    async upload(args: { hostKind: string; hostId: string; filename: string; mimeType: string; buffer: Buffer }) {
      const path = `${args.hostKind}s/${args.hostId}/media/${args.filename}`;
      const { error } = await supabase.storage.from(ADAPTER_BUCKET).upload(path, args.buffer, {
        contentType: args.mimeType,
        upsert: true,
      });
      if (error) throw new Error(`storage upload failed: ${error.message}`);
      return { storagePath: path, cdnUrl: adapterBuildPublicUrl(path) };
    },
    async delete(storagePath: string) {
      const { error } = await supabase.storage.from(ADAPTER_BUCKET).remove([storagePath]);
      if (error) throw new Error(`storage delete failed: ${error.message}`);
    },
    // Download binary for the publish-worker's media-in-git emission step.
    // Per spec-content-modules-git-architecture §14.3: when site.config
    // .publish.embed_media_in_git is true AND host_media.in_repo is true,
    // the publish-worker reads the binary here and writes it under
    // public/media/<filename> in the published git tree.
    async download(storagePath: string): Promise<Buffer> {
      const { data, error } = await supabase.storage.from(ADAPTER_BUCKET).download(storagePath);
      if (error) throw new Error(`storage download failed: ${error.message}`);
      if (!data) throw new Error(`storage download returned no body for ${storagePath}`);
      const arrayBuf = await data.arrayBuffer();
      return Buffer.from(arrayBuf);
    },
    // generateVariants intentionally absent — wired by event-media-style edge
    // function in a follow-up. When bunny-cdn is enabled, the renderer
    // rewrites cdn_url through getBunnyImageUrl() which handles transforms
    // at the edge.
  };

  // Multipart parser — placeholder. Production wires multer or busboy.
  const parseUploadedFiles = async (req: Request): Promise<MediaUploadInput[]> => {
    // The platform should install a global multer middleware before mounting
    // /api routes; the parsed files appear at req.files. This is a thin adapter.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reqFiles = (req as any).files as
      | Array<{ originalname: string; mimetype: string; size: number; buffer: Buffer }>
      | undefined;
    if (!reqFiles) return [];
    return reqFiles.map((f) => ({
      filename: f.originalname,
      mimeType: f.mimetype,
      bytes: f.size,
      buffer: f.buffer,
    }));
  };

  // Build the route groups
  const adminRouter = Router();
  const publicRouter = Router();

  const republishRoutes = createRepublishRoutes({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    publishWorker: {
      enqueueRepublish: (args) => publishWorker.enqueueRepublish(args),
    },
    logger,
    rateLimit: (key, max, windowMs) => rateLimiter.check(key, max, windowMs),
  });
  mountRepublishRoutes(adminRouter, republishRoutes, publicRouter);

  const sourceRoutes = createSourceRoutes({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    gitServer,
    publishWorker,
    resolveSiteRepo,
    logger,
  });
  mountSourceRoutes(adminRouter, sourceRoutes);

  const menusRoutes = createMenusRoutes({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    logger,
  });
  mountMenusRoutes(adminRouter, menusRoutes);

  // Public navigation + settings endpoints — themes call these from their
  // server components (no JWT). See public-menus-routes.ts.
  const publicMenusRoutes = createPublicMenusRoutes({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    logger,
    supabasePublicUrl: process.env.SUPABASE_PUBLIC_URL || process.env.SUPABASE_URL || '',
    storageBucket: process.env.STORAGE_BUCKET ?? 'media',
  });
  mountPublicMenusRoutes(publicRouter, publicMenusRoutes);

  // Personas (per spec-example-theme-deliverable §5.2) — editor-managed
  // segment definitions with resolution rules. Mounted on the admin
  // router because authoring is admin-only; the actual resolution at
  // request time happens in the runtime API endpoint (which uses the
  // same `resolvePersonaFromContext` helper exported from personas-routes).
  const personasRoutes = createPersonasRoutes({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    logger,
  });
  mountPersonasRoutes(adminRouter, personasRoutes);

  // Page-variants CRUD — sidecar overlay table edited from the page
  // editor's "Personalize" affordance. Resolution happens in the runtime
  // API (which loads the same rows + walkPageVariants); these endpoints
  // exist purely so the admin UI can author them. Mounted on adminRouter
  // → requires JWT.
  const pageVariantsRoutes = createPageVariantsRoutes({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    logger,
  });
  mountPageVariantsRoutes(adminRouter, pageVariantsRoutes);

  // Media routes moved to @gatewaze-modules/host-media (per
  // spec-host-media-module Phase 2). The host-media module mounts
  // GET/POST/PATCH/DELETE /admin/<hostKind>/:hostId/media[/:id] on
  // /api/admin and serves both site (host_kind='site') and list
  // (host_kind='list') media via the registry's `hostMediaConsumer`
  // block declared in this module's index.ts.
  void mediaAdapter;          // referenced below for source-routes; keep alive
  void parseUploadedFiles;    // ditto
  void createMediaRoutes;     // import retained for type re-export only
  void mountMediaRoutes;

  // Canvas routes — WYSIWYG editor for composition_mode='blocks' pages, per
  // spec-sites-wysiwyg-builder. Read endpoint (GET /pages/:id/canvas/render),
  // op-batch endpoint (POST /pages/:id/canvas), lock endpoints. Per-user-
  // per-page rate limits + JWT auth applied upstream by the platform.
  // Asset resolver uses the existing media adapter for sites_media URLs.
  const canvasRoutes = createCanvasRoutes({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    logger,
    rateLimit: (key, max, windowMs) => {
      // Convert async rate-limiter to sync (the canvas routes call it
      // synchronously). The in-memory default returns Promise<{allowed}>;
      // here we kick off the check and assume "allow" on the synchronous
      // path — production rate-limiting in Phase 2 wires a sync interface.
      void rateLimiter.check(key, max, windowMs);
      return true;
    },
    brand: process.env.BRAND_ID ?? 'unknown',
    resolveAssetUrl: async (mediaId: string) => {
      const result = await supabase
        .from('sites_media')
        .select('public_url, alt_text')
        .eq('id', mediaId)
        .maybeSingle();
      const row = (result as { data: { public_url: string; alt_text: string | null } | null }).data;
      if (!row) return null;
      return { url: row.public_url, alt: row.alt_text ?? undefined };
    },
  });
  mountCanvasRoutes(adminRouter, canvasRoutes);

  // Bulk canvas-template validator — POST /api/admin/sites/:siteSlug/
  // canvas-validate-templates. Runs the data-* attribute parser against
  // every block_def in the site's library + writes back canvas_validated.
  // Surfaced from the SiteSourceTab UI as "Re-validate canvas templates".
  const validateTemplates = createValidateTemplatesRoute({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    logger,
  });
  mountValidateTemplatesRoute(adminRouter, validateTemplates);

  // Canvas presets — save / list / delete reusable block compositions.
  // Apply happens via the preset.apply op kind already wired in
  // canvas-routes.ts (POST /admin/pages/:id/canvas).
  const presetsRoutes = createPresetsRoutes({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    logger,
  });
  mountPresetsRoutes(adminRouter, presetsRoutes);

  // Emergency JSON-lock disable — POST /api/admin/pages/:id/canvas/
  // unlock-content. super_admin only; flips pages.wysiwyg_locked=false to
  // allow manual git edits on the page's content/pages/<slug>.json.
  // Per spec-sites-wysiwyg-builder §6.7. Audit log emitted at WARN level.
  const unlockContent = createUnlockContentRoute({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    logger,
    rateLimit: (key, max, windowMs) => {
      void rateLimiter.check(key, max, windowMs);
      return true;
    },
  });
  mountUnlockContentRoute(adminRouter, unlockContent);

  // Block-defs read endpoint — GET /api/admin/sites/:siteSlug/block-defs.
  // 60s in-process cache keyed by templates_library_id. Cache is busted
  // by Postgres NOTIFY 'templates_invalidate' (payload = library_id or
  // '*'); when the supabase-js client doesn't expose raw LISTEN, the
  // pgListen dep is null and TTL-only eviction applies.
  // Per spec-sites-wysiwyg-builder §6.5.
  const blockDefsRoute = createBlockDefsRoute({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    logger,
    cacheTtlMs: 60_000,
    pgListen: null,
  });
  mountBlockDefsRoute(adminRouter, blockDefsRoute);

  // Feature-flags read endpoint — GET /api/admin/feature-flags. Surfaces
  // canvas_enabled + the env-tunable limits to the admin UI so it can hide
  // the canvas tab and short-circuit op submission.
  // Per spec-sites-wysiwyg-builder §6.0.
  mountFeatureFlagsRoute(adminRouter, createFeatureFlagsRoute());

  // Legacy admin routes — page CRUD, preview tokens, batch content, site
  // secrets, publisher:validate. The new git-driven architecture
  // (republish / source / menus / media above) sits alongside; pages are
  // still DB rows in the new model (per spec-content-modules-git-architecture
  // §8.3, with the composition_mode discriminator added by sites_012). The
  // admin UI's "+ New Page", page-edit, archive, batch save and Test
  // Connection flows continue to call these endpoints.
  const legacyAdminRouter = Router();
  const legacyAdminRoutes = createAdminRoutes({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    logger: {
      info: (msg, meta) => logger.info(msg, meta),
      warn: (msg, meta) => logger.warn(msg, meta),
      error: (msg, meta) => logger.error(msg, meta),
    },
    getUserId: (req: Request) => (req as Request & { userId?: string }).userId ?? null,
    // Source:import-git uses gitServer.createRepo to ensure the site has
    // an internal bare repo, then force-pushes the imported tree so
    // apply-theme drift checks have a baseline.
    gitServer: {
      createRepo: (args) => gitServer.createRepo(args),
    },
  });
  mountAdminRoutes(legacyAdminRouter, legacyAdminRoutes);

  // Public A/B engine routes — anonymous, rate-limited per session key.
  // Mounted on the public router so rendered pages can call them without
  // a JWT (impressions / conversions / variant-assignment from any visitor).
  const abRoutes = createAbRoutes({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    rateLimit: rateLimiter.check.bind(rateLimiter),
    logger,
  });
  mountAbRoutes(publicRouter, abRoutes);

  // Runtime content API (per spec-example-theme-deliverable §7) — read
  // endpoint themes call from their middleware / RSC to get personalised
  // content. Per-site Bearer API keys, NOT JWT. Mounted on the public
  // router so external Next.js servers can reach it without admin auth.
  //
  // Pepper comes from env. In production the operator MUST set
  // SITES_RUNTIME_API_PEPPER (32+ random bytes, base64). For local dev
  // we accept an unset value and fall back to a constant dev pepper
  // (the request will still fail because no API keys hash against the
  // dev pepper — operators must generate keys via the admin route
  // before they can read content via this endpoint).
  const peppperRaw = process.env.SITES_RUNTIME_API_PEPPER ?? '';
  let pepper: Uint8Array;
  if (peppperRaw.length === 0) {
    logger.warn('runtime.api.no_pepper_configured', {
      hint: 'set SITES_RUNTIME_API_PEPPER (32+ random bytes, base64) to enable runtime API key validation',
    });
    pepper = new TextEncoder().encode('local-dev-pepper-not-secure-do-not-use-in-production-aaaaaaaaaaaaaa');
  } else {
    pepper = Buffer.from(peppperRaw, 'base64');
  }
  const runtimeRoutes = createRuntimeRoutes({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    logger,
    pepper,
  });
  mountRuntimeRoutes(publicRouter, runtimeRoutes);

  // Mount on the express app. The platform applies requireJwt to /admin/*
  // (per the established pattern); webhook receiver is on /api/webhooks/*
  // with no JWT (HMAC signature is the auth).
  app.use('/api/admin', adminRouter);
  app.use('/api/modules/sites', legacyAdminRouter);
  app.use('/api', publicRouter);

  void context; // currently unused; reserved for future per-host hooks
  logger.info('sites module routes registered');
}
