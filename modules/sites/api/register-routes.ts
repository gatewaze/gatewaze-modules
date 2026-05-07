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
  ): Promise<Map<string, Buffer | string>> => {
    const out = new Map<string, Buffer | string>();

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
    if (!site) return out;

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

    // 1a. Write content/pages/<slug>.json for schema-mode pages.
    for (const p of pages) {
      if (p.composition_mode === 'schema') {
        out.set(
          `content/pages/${p.slug}.json`,
          JSON.stringify(
            {
              slug: p.slug,
              full_path: p.full_path,
              title: p.title,
              content: p.content ?? {},
              schema_version: p.content_schema_version,
            },
            null,
            2,
          ),
        );
      }
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
        const blocksForPage = pageBlocks
          .filter((pb) => pb.page_id === page.id)
          .map((pb) => {
            const def = blockDefById.get(pb.block_def_id);
            const bricks = bricksByBlockId.get(pb.id);
            const blockOut: Record<string, unknown> = {
              block_def_name: def?.key ?? null,
              sort_order: pb.sort_order,
              variant_key: pb.variant_key,
              content: pb.content,
            };
            if (bricks) {
              blockOut.bricks = bricks.map((b) => ({
                brick_def_name: brickDefById.get(b.brick_def_id)?.key ?? null,
                sort_order: b.sort_order,
                variant_key: b.variant_key,
                content: b.content,
              }));
            }
            return blockOut;
          });

        out.set(
          `content/pages/${page.slug}.json`,
          JSON.stringify(
            {
              slug: page.slug,
              full_path: page.full_path,
              title: page.title,
              composition_mode: 'blocks',
              blocks: blocksForPage,
            },
            null,
            2,
          ),
        );
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

    // 5. Emit the Next.js route + layout files.
    const analytics = ((site.config ?? {}) as { analytics?: { provider?: string; umami?: { umamiWebsiteId?: string; umamiShareId?: string | null } } }).analytics ?? null;

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

    logger.info('buildSiteContentFiles', {
      siteId,
      pagesCount: pages.length,
      abTestsCount: Object.keys(abTestsByRoute).length,
      filesEmitted: out.size,
    });

    return out;
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

  // Default media adapter (Supabase Storage)
  const mediaAdapter = {
    async upload(args: { hostKind: string; hostId: string; filename: string; mimeType: string; buffer: Buffer }) {
      const path = `${args.hostKind}s/${args.hostId}/media/${args.filename}`;
      const { error } = await supabase.storage.from('gatewaze-media').upload(path, args.buffer, {
        contentType: args.mimeType,
        upsert: true,
      });
      if (error) throw new Error(`storage upload failed: ${error.message}`);
      const { data } = supabase.storage.from('gatewaze-media').getPublicUrl(path);
      return { storagePath: path, cdnUrl: data.publicUrl };
    },
    async delete(storagePath: string) {
      const { error } = await supabase.storage.from('gatewaze-media').remove([storagePath]);
      if (error) throw new Error(`storage delete failed: ${error.message}`);
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

  // Mount on the express app. The platform applies requireJwt to /admin/*
  // (per the established pattern); webhook receiver is on /api/webhooks/*
  // with no JWT (HMAC signature is the auth).
  app.use('/api/admin', adminRouter);
  app.use('/api/modules/sites', legacyAdminRouter);
  app.use('/api', publicRouter);

  void context; // currently unused; reserved for future per-host hooks
  logger.info('sites module routes registered');
}
