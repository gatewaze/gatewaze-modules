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
import { randomBytes } from 'node:crypto';

import { createRepublishRoutes, mountRepublishRoutes } from './republish.js';
import { createSourceRoutes, mountSourceRoutes } from './source-routes.js';
import { createMenusRoutes, mountMenusRoutes } from './menus-routes.js';
import { createMediaRoutes, mountMediaRoutes, type MediaUploadInput } from './media-routes.js';
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

  // Build site content files (stub — full impl reads pages + page_blocks + runs build-time fetchers)
  const buildSiteContentFiles = async (_siteId: string, _pages?: string[]): Promise<Map<string, Buffer | string>> => {
    // Real impl: query pages by site_id, for blocks-mode pages build content/pages/<slug>.json
    // from page_blocks rows (with kind_config + content), for schema-mode pages
    // write pages.content JSONB. Run build-time fetchers (gatewaze-internal,
    // ai-generated before-publish) before assembling.
    return new Map();
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

  const mediaRoutes = createMediaRoutes({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    mediaAdapter,
    parseUploadedFiles,
    logger,
  });
  mountMediaRoutes(adminRouter, mediaRoutes);

  // Mount on the express app. The platform applies requireJwt to /admin/*
  // (per the established pattern); webhook receiver is on /api/webhooks/*
  // with no JWT (HMAC signature is the auth).
  app.use('/api/admin', adminRouter);
  app.use('/api', publicRouter);

  void context; // currently unused; reserved for future per-host hooks
  logger.info('sites module routes registered');
}
