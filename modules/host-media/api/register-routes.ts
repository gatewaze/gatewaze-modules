// @ts-nocheck — see routes.ts header.

/**
 * Host-media module — apiRoutes hook entry point. Wires multer +
 * mediaAdapter + supabase + the route handlers, mounts on the
 * platform's express app under /api/admin/<hostKind>/...
 *
 * Auth: requireJwt() runs upstream via the platform's
 * /api/modules mount (modulesRouter applies it on entry). req.userId
 * is populated by the time our handlers run.
 *
 * Per spec-host-media-module §4.1 (multer mount) + §11.
 */

import type { ModuleContext } from '@gatewaze/shared';
import { createClient } from '@supabase/supabase-js';
import { Router, type Express, type Request } from 'express';
import multer from 'multer';

import { createMediaRoutes, mountMediaRoutes, type MediaUploadInput, type MediaAdapter } from './routes.js';
import { createAlbumsRoutes, mountAlbumsRoutes } from './albums-routes.js';
import { createChunkedRoutes, mountChunkedRoutes } from './chunked-routes.js';
import { requireJwt } from '../lib/require-jwt.js';

// Canonical bucket per spec-relative-storage-paths.md: a single `media`
// bucket per Gatewaze instance. HOST_MEDIA_BUCKET remains an override for
// installs that historically split media across multiple buckets, but
// new deployments should leave it unset.
const STORAGE_BUCKET = process.env.HOST_MEDIA_BUCKET ?? 'media';

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
    info: (msg, meta) => console.log(`[host-media] ${msg}`, meta ?? ''),
    warn: (msg, meta) => console.warn(`[host-media] ${msg}`, meta ?? ''),
    error: (msg, meta) => console.error(`[host-media] ${msg}`, meta ?? ''),
  };
}

function defaultRateLimiter(): RateLimiter {
  // In-memory sliding window. Production wires the platform's shared
  // rate limiter when one is available.
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

  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Public-facing URL used in cdn_url responses + image src attributes.
  // SUPABASE_URL is typically the internal docker hostname
  // (http://supabase-kong:8000) for server-to-server calls. The browser
  // can't resolve that hostname, so cdn_url responses must use the
  // EXTERNAL hostname — set by `SUPABASE_PUBLIC_URL`. Falls back to
  // SUPABASE_URL when not set (cloud envs where they're the same).
  const publicSupabaseUrl = (process.env.SUPABASE_PUBLIC_URL || supabaseUrl).replace(/\/+$/, '');

  /** Build a public URL for an object in our storage bucket. Mirrors
   *  the Supabase JS client's getPublicUrl shape but using the external
   *  hostname so browsers can resolve it. */
  function buildPublicUrl(storagePath: string): string {
    return `${publicSupabaseUrl}/storage/v1/object/public/${STORAGE_BUCKET}/${storagePath}`;
  }

  // Default media adapter (Supabase Storage).
  const mediaAdapter: MediaAdapter = {
    async upload(args) {
      const path = `${args.hostKind}/${args.hostId}/${args.mediaId}/${args.filename}`;
      const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, args.buffer, {
        contentType: args.mimeType,
        upsert: false,
      });
      if (error) throw new Error(`storage upload failed: ${error.message}`);
      return { storagePath: path, cdnUrl: buildPublicUrl(path) };
    },
    async delete(storagePath) {
      const { error } = await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]);
      if (error) throw new Error(`storage delete failed: ${error.message}`);
    },
    getPublicUrl(storagePath) {
      return buildPublicUrl(storagePath);
    },
    async createSignedUrl(storagePath, ttlSeconds) {
      const { data, error } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(storagePath, ttlSeconds);
      if (error || !data?.signedUrl) throw new Error(`signed-url failed: ${error?.message ?? 'unknown'}`);
      return data.signedUrl;
    },
  };

  // Multipart parser — applied to the upload route only (not the
  // whole router) so JSON endpoints aren't broken. This lesson came
  // from today's sites work: the platform applies neither multer nor
  // any global multipart middleware; modules must mount their own.
  const mediaUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024, files: 20 },
  }).array('files', 20);

  const parseUploadedFiles = async (req: Request): Promise<MediaUploadInput[]> => {
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

  const adminRouter = Router();
  // requireJwt applied directly to the adminRouter — the platform
  // doesn't gate /api/admin/* itself, and we cannot rely on the
  // /api/modules overlap pattern since we mount under /api/admin.
  adminRouter.use(requireJwt());

  const mediaRoutes = createMediaRoutes({
    supabase,
    mediaAdapter,
    parseUploadedFiles,
    rateLimit: rateLimiter.check.bind(rateLimiter),
    logger,
  });
  mountMediaRoutes(adminRouter, mediaRoutes, mediaUpload);

  const albumsRoutes = createAlbumsRoutes({ supabase, logger });
  mountAlbumsRoutes(adminRouter, albumsRoutes);

  const chunkedRoutes = createChunkedRoutes({ supabase, storageBucket: STORAGE_BUCKET, logger });
  mountChunkedRoutes(adminRouter, chunkedRoutes);

  // Mount on the express app at /api/admin. requireJwt() runs upstream
  // via /api/modules.
  app.use('/api/admin', adminRouter);

  void context;
  logger.info('host-media module routes registered');
}
