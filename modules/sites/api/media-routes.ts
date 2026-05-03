/**
 * Host-media admin endpoints (sites + lists share the same surface,
 * dispatched on `:hostKind`).
 *
 * Per spec-content-modules-git-architecture §22.4:
 *
 *   POST   /admin/<hostKind>/:hostId/media              — multipart upload
 *   DELETE /admin/<hostKind>/:hostId/media/:mediaId     — delete (usage check)
 *   PATCH  /admin/<hostKind>/:hostId/media/:mediaId     — replace file
 *
 * The handlers:
 *   1. Accept multipart upload (multer, formidable, busboy — caller wires)
 *   2. Per-file size check vs host_media_quotas
 *   3. Hybrid storage routing: ≤2MB → repo `media/`, >2MB → CDN-only with
 *      manifest (per spec §14.3)
 *   4. Upload to Supabase Storage (or configured MediaAdapter)
 *   5. If bunny-cdn module installed, the URL rewriter wraps cdn_url
 *      output via getBunnyImageUrl() at render time (handled in the
 *      published-output renderer, not here)
 *   6. Generate variants if no Bunny module (mirrors event-media's
 *      media-process-image edge function)
 *   7. Insert host_media row with used_in=[] (populated transactionally
 *      by MediaReferenceTracker on subsequent content writes)
 */

import type { Request, Response, Router } from 'express';
import { createHash } from 'node:crypto';

interface RequestWithUser extends Request {
  user?: { id: string };
}

interface ErrorEnvelope {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface MediaUploadInput {
  filename: string;
  mimeType: string;
  bytes: number;
  buffer: Buffer;
  width?: number;
  height?: number;
}

export interface MediaAdapter {
  /** Upload to backing store (Supabase Storage / S3 / R2). Returns the storage_path + cdn_url. */
  upload(args: { hostKind: string; hostId: string; filename: string; mimeType: string; buffer: Buffer }): Promise<{
    storagePath: string;
    cdnUrl: string;
  }>;
  /** Delete an asset by storage_path. */
  delete(storagePath: string): Promise<void>;
  /**
   * Generate variants (thumbnails, responsive widths) when bunny-cdn is not
   * installed. Returns map of widthKey → storage_path. No-op when Bunny
   * handles transforms at the edge.
   */
  generateVariants?: (args: { storagePath: string; mimeType: string }) => Promise<Record<string, string>>;
}

export interface MediaRoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any; rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> };
  mediaAdapter: MediaAdapter;
  /**
   * Threshold above which a file goes CDN-only (with manifest entry).
   * Default 2 MiB per spec §14.3.
   */
  repoSizeThresholdBytes?: number;
  /**
   * Per-file CDN cap (default 5 MiB) and per-host total cap (default 1 GiB).
   * Enforced server-side regardless of host_media_quotas overrides.
   */
  perFileCdnCap?: number;
  perHostTotalCap?: number;
  /** Parsed multipart files supplied by the wrapping middleware (multer/busboy). */
  parseUploadedFiles: (req: Request) => Promise<MediaUploadInput[]>;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

const DEFAULT_REPO_THRESHOLD = 2 * 1024 * 1024;
const DEFAULT_CDN_CAP = 5 * 1024 * 1024;
const DEFAULT_HOST_TOTAL_CAP = 1024 * 1024 * 1024;

function paramAs(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return undefined;
}

function contentAddressedFilename(filename: string, buffer: Buffer): string {
  const sha = createHash('sha256').update(buffer).digest('hex').slice(0, 8);
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return `${filename}-${sha}`;
  return `${filename.slice(0, dot)}-${sha}${filename.slice(dot)}`;
}

export function createMediaRoutes(deps: MediaRoutesDeps) {
  const repoThreshold = deps.repoSizeThresholdBytes ?? DEFAULT_REPO_THRESHOLD;
  const cdnCap = deps.perFileCdnCap ?? DEFAULT_CDN_CAP;
  const hostTotalCap = deps.perHostTotalCap ?? DEFAULT_HOST_TOTAL_CAP;

  async function uploadMedia(req: RequestWithUser, res: Response): Promise<void> {
    const hostKind = paramAs(req.params.hostKind);
    const hostId = paramAs(req.params.hostId);
    if (!hostKind || !hostId) {
      res.status(400).json({ error: 'missing_params', message: 'hostKind and hostId required' } satisfies ErrorEnvelope);
      return;
    }
    if (hostKind !== 'site' && hostKind !== 'list') {
      res.status(400).json({ error: 'invalid_host_kind', message: `hostKind must be 'site' or 'list' (got: ${hostKind})` } satisfies ErrorEnvelope);
      return;
    }

    const files = await deps.parseUploadedFiles(req);
    if (files.length === 0) {
      res.status(400).json({ error: 'no_files', message: 'at least one file required' } satisfies ErrorEnvelope);
      return;
    }

    // Lookup current host total usage
    const quotaResult = await deps.supabase
      .from('host_media_quotas')
      .select('total_bytes_used, total_bytes_cap, per_file_cdn_cap, per_file_repo_cap')
      .eq('host_kind', hostKind).eq('host_id', hostId).single();
    const quota = (quotaResult.data as
      | { total_bytes_used: number; total_bytes_cap: number; per_file_cdn_cap: number; per_file_repo_cap: number }
      | null) ?? { total_bytes_used: 0, total_bytes_cap: hostTotalCap, per_file_cdn_cap: cdnCap, per_file_repo_cap: repoThreshold };

    const items: Array<Record<string, unknown>> = [];
    let anyFailed = false;

    for (const file of files) {
      try {
        // Per-file cap check
        if (file.bytes > quota.per_file_cdn_cap) {
          items.push({
            filename: file.filename,
            status: 'failed',
            error: 'file_too_large',
            message: `file ${file.filename} (${file.bytes} bytes) exceeds per-file cap (${quota.per_file_cdn_cap})`,
          });
          anyFailed = true;
          continue;
        }
        // Per-host total cap check
        if (quota.total_bytes_used + file.bytes > quota.total_bytes_cap) {
          items.push({
            filename: file.filename,
            status: 'failed',
            error: 'media_quota_exceeded',
            message: `host quota of ${quota.total_bytes_cap} bytes exceeded`,
          });
          anyFailed = true;
          continue;
        }

        const inRepo = file.bytes <= quota.per_file_repo_cap;
        const finalFilename = contentAddressedFilename(file.filename, file.buffer);

        // Upload to CDN (Supabase Storage by default)
        const upload = await deps.mediaAdapter.upload({
          hostKind, hostId, filename: finalFilename, mimeType: file.mimeType, buffer: file.buffer,
        });

        // Generate variants when no Bunny CDN
        let variants: Record<string, string> | null = null;
        if (deps.mediaAdapter.generateVariants && file.mimeType.startsWith('image/')) {
          variants = await deps.mediaAdapter.generateVariants({ storagePath: upload.storagePath, mimeType: file.mimeType });
        }

        // Insert host_media row
        const inserted = await deps.supabase.from('host_media').insert({
          host_kind: hostKind,
          host_id: hostId,
          storage_path: upload.storagePath,
          filename: file.filename,
          mime_type: file.mimeType,
          bytes: file.bytes,
          width: file.width,
          height: file.height,
          variants,
          in_repo: inRepo,
          uploaded_by: req.user?.id ?? null,
        }).select().single();

        if (inserted.error) {
          // Roll back the upload
          try { await deps.mediaAdapter.delete(upload.storagePath); } catch { /* swallow */ }
          items.push({ filename: file.filename, status: 'failed', error: 'db_error', message: inserted.error.message });
          anyFailed = true;
          continue;
        }

        items.push({
          status: 'created',
          id: inserted.data.id,
          filename: file.filename,
          mime_type: file.mimeType,
          bytes: file.bytes,
          in_repo: inRepo,
          storage_path: upload.storagePath,
          cdn_url: upload.cdnUrl,
          variants,
        });

        // Update quota usage
        await deps.supabase
          .from('host_media_quotas')
          .update({ total_bytes_used: quota.total_bytes_used + file.bytes })
          .eq('host_kind', hostKind).eq('host_id', hostId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        items.push({ filename: file.filename, status: 'failed', error: 'upload_failed', message });
        anyFailed = true;
      }
    }

    res.status(anyFailed && items.some((i) => i.status === 'created') ? 207 : items.every((i) => i.status === 'created') ? 201 : 400).json({ items });
  }

  async function deleteMedia(req: RequestWithUser, res: Response): Promise<void> {
    const hostKind = paramAs(req.params.hostKind);
    const hostId = paramAs(req.params.hostId);
    const mediaId = paramAs(req.params.mediaId);
    if (!hostKind || !hostId || !mediaId) {
      res.status(400).json({ error: 'missing_params', message: 'all params required' } satisfies ErrorEnvelope);
      return;
    }

    const itemResult = await deps.supabase
      .from('host_media')
      .select('id, storage_path, bytes, used_in')
      .eq('id', mediaId).eq('host_kind', hostKind).eq('host_id', hostId)
      .single();
    const item = itemResult.data as { id: string; storage_path: string; bytes: number; used_in: Array<{ type: string; id: string; name: string }> } | null;
    if (!item) {
      res.status(404).json({ error: 'media_not_found', message: 'media item not found' } satisfies ErrorEnvelope);
      return;
    }
    if (item.used_in.length > 0) {
      res.status(409).json({
        error: 'media_in_use',
        message: `cannot delete: used in ${item.used_in.length} place${item.used_in.length === 1 ? '' : 's'}`,
        details: { usedIn: item.used_in },
      } satisfies ErrorEnvelope);
      return;
    }

    try { await deps.mediaAdapter.delete(item.storage_path); }
    catch (err) { deps.logger.warn('media adapter delete failed (non-fatal)', { storagePath: item.storage_path, error: err instanceof Error ? err.message : String(err) }); }

    await deps.supabase.from('host_media').delete().eq('id', mediaId);
    // Update quota
    await deps.supabase.rpc('host_media_quota_decrement', { p_host_kind: hostKind, p_host_id: hostId, p_bytes: item.bytes });
    res.status(204).end();
  }

  return { uploadMedia, deleteMedia };
}

export function mountMediaRoutes(router: Router, routes: ReturnType<typeof createMediaRoutes>): void {
  router.post('/:hostKind/:hostId/media', routes.uploadMedia);
  router.delete('/:hostKind/:hostId/media/:mediaId', routes.deleteMedia);
}
