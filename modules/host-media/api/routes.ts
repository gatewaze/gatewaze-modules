// @ts-nocheck — depends on @supabase/supabase-js + express which require
// pnpm install at the modules workspace level. Excluded from strict
// tsconfig until the workspace install is wired up; runtime shape is
// correct.

/**
 * Host-media core API routes — list, single, upload, patch, delete,
 * authenticated-asset proxy, signed-URL issuance.
 *
 * All routes mounted under /api/admin/<hostKind>/:hostId/... by
 * register-routes.ts. requireJwt() runs upstream via the platform's
 * /api/modules mount (modulesRouter applies it on entry).
 *
 * Per spec-host-media-module §5.
 */

import type { Request, Response, Router } from 'express';
import { isKnownHostKind, getHostMediaConsumer } from '../lib/registry.js';
import { buildStoragePath, sanitiseFilename } from '../lib/storage-paths.js';
import {
  sanitisePostgrestSearch,
  pickFields,
  paramAsUuid,
  paramAsString,
  parseUuidList,
  validateMediaPatch,
} from '../lib/sanitisers.js';
import { buildRateLimitKey, UPLOAD_RATE_LIMIT, SIGNED_URL_RATE_LIMIT } from '../lib/rate-limit-keys.js';
import { MEDIA_PATCH_FIELDS } from '../types/index.js';

interface ErrorEnvelope {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

interface RequestWithUser extends Request {
  userId?: string;
}

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

interface RateLimiter {
  check(key: string, max: number, windowMs: number): Promise<{ allowed: boolean; resetAt: number }>;
}

export interface MediaUploadInput {
  filename: string;
  mimeType: string;
  bytes: number;
  buffer: Buffer;
}

export interface MediaAdapter {
  /**
   * Upload buffer to storage. mediaId is server-generated and fed in so
   * the path is collision-free.
   */
  upload(args: {
    hostKind: string;
    hostId: string;
    mediaId: string;
    filename: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<{ storagePath: string; cdnUrl: string }>;
  delete(storagePath: string): Promise<void>;
  /** Build the public CDN URL for a stored object. */
  getPublicUrl(storagePath: string): string;
  /** Issue a 1 h signed URL for a stored object (for access_level='signed'). */
  createSignedUrl(storagePath: string, ttlSeconds: number): Promise<string>;
  /**
   * Optional on-the-fly resized image URL (Supabase image transformation).
   * Used for grid/viewer previews of images that have no stored variant.
   */
  getRenderUrl?(storagePath: string, width: number): string;
}

export interface RoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  mediaAdapter: MediaAdapter;
  parseUploadedFiles: (req: Request) => Promise<MediaUploadInput[]>;
  rateLimit: RateLimiter['check'];
  logger: PlatformLogger;
}

function sendError(res: Response, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  const body: ErrorEnvelope = { error: code, message };
  if (details) body.details = details;
  res.status(status).json(body);
}

const LIST_COLUMNS = 'id, host_kind, host_id, storage_path, filename, mime_type, bytes, width, height, duration, variants, in_repo, used_in, uploaded_by, access_level, youtube_video_id, youtube_url, youtube_embed_url, youtube_thumbnail_url, youtube_upload_status, album_id, metadata, caption, alt_text, sponsor_id, is_featured, is_approved, display_order, created_at, updated_at';

/** Storage paths a media row owns: the original plus any stored variants. */
function ownedStoragePaths(row: { storage_path: string; variants?: unknown }): string[] {
  const paths = [row.storage_path];
  if (row.variants && typeof row.variants === 'object') {
    for (const v of Object.values(row.variants as Record<string, unknown>)) {
      if (typeof v === 'string' && v && !/^https?:/i.test(v)) paths.push(v);
    }
  }
  return paths;
}

/**
 * A PATCH may point album_id only at an album of the same host; the FK
 * alone would accept any host's album. Returns false when it does not.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function albumIdIsValid(supabase: any, fields: Record<string, unknown>, hostKind: string, hostId: string): Promise<boolean> {
  const albumId = fields['album_id'];
  if (albumId === undefined || albumId === null) return true;
  const { data } = await supabase
    .from('host_media_albums')
    .select('id')
    .eq('id', albumId)
    .eq('host_kind', hostKind)
    .eq('host_id', hostId)
    .maybeSingle();
  return !!data;
}

function validateHostKindParam(req: Request, res: Response): { hostKind: string; hostId: string } | null {
  const hostKind = paramAsString(req.params['hostKind']);
  const hostId = paramAsUuid(req.params['hostId']);
  if (!hostKind) {
    sendError(res, 400, 'missing_params', 'hostKind required');
    return null;
  }
  if (!hostId) {
    sendError(res, 400, 'invalid_host_id', 'hostId must be a UUID');
    return null;
  }
  if (!isKnownHostKind(hostKind)) {
    sendError(res, 400, 'invalid_host_kind', `unknown host_kind: ${hostKind}`);
    return null;
  }
  return { hostKind, hostId };
}

export function createMediaRoutes(deps: RoutesDeps) {
  const { supabase, mediaAdapter, parseUploadedFiles, rateLimit, logger } = deps;

  // ────────────────────────────────────────────────────────────────────
  // GET /admin/<hostKind>/:hostId/media
  // ────────────────────────────────────────────────────────────────────
  async function listMedia(req: RequestWithUser, res: Response): Promise<void> {
    const params = validateHostKindParam(req, res);
    if (!params) return;
    const { hostKind, hostId } = params;

    const filter = paramAsString(req.query['filter']) ?? 'all';
    const albumId = paramAsUuid(req.query['album_id']);
    const search = sanitisePostgrestSearch(req.query['search'] ?? '');
    const limit = Math.max(1, Math.min(Number(req.query['limit']) || 100, 500));
    const offset = Math.max(0, Math.floor(Number(req.query['offset']) || 0));

    // Stable order (created_at, id) so offset paging never skips or
    // repeats a row when two uploads share a timestamp.
    let query = supabase
      .from('host_media')
      .select(LIST_COLUMNS)
      .eq('host_kind', hostKind)
      .eq('host_id', hostId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    if (filter === 'photo') query = query.like('mime_type', 'image/%');
    else if (filter === 'video') query = query.like('mime_type', 'video/%');
    else if (filter === 'audio') query = query.like('mime_type', 'audio/%');

    if (albumId) query = query.eq('album_id', albumId);
    if (search) query = query.or(`filename.ilike.%${search}%,caption.ilike.%${search}%,alt_text.ilike.%${search}%`);

    const result = await query;
    if (result.error) {
      logger.error('host_media list failed', { hostKind, hostId, error: result.error.message });
      sendError(res, 500, 'list_failed', result.error.message);
      return;
    }

    interface Row { id: string; storage_path: string; [key: string]: unknown }
    const rows = (result.data ?? []) as Row[];
    const items = rows.map(withUrls);

    // next_cursor is the next offset while a full page came back.
    res.status(200).json({ items, next_cursor: rows.length === limit ? String(offset + limit) : null });
  }

  function withUrls<T extends { storage_path: string; mime_type?: unknown; variants?: unknown }>(r: T) {
    const variants = (r.variants && typeof r.variants === 'object' ? r.variants : {}) as Record<string, unknown>;
    const isImage = typeof r.mime_type === 'string' && r.mime_type.startsWith('image/');
    const preview = (key: string, width: number): string | null => {
      const v = variants[key];
      if (typeof v === 'string' && v) return /^https?:/i.test(v) ? v : mediaAdapter.getPublicUrl(v);
      if (isImage && mediaAdapter.getRenderUrl) return mediaAdapter.getRenderUrl(r.storage_path, width);
      return null;
    };
    return {
      ...r,
      cdn_url: mediaAdapter.getPublicUrl(r.storage_path),
      thumb_url: preview('thumb', 350),
      medium_url: preview('medium', 800),
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // GET /admin/<hostKind>/:hostId/media/:id
  // ────────────────────────────────────────────────────────────────────
  async function getMedia(req: RequestWithUser, res: Response): Promise<void> {
    const params = validateHostKindParam(req, res);
    if (!params) return;
    const mediaId = paramAsUuid(req.params['id']);
    if (!mediaId) {
      sendError(res, 400, 'invalid_media_id', 'media id must be a UUID');
      return;
    }

    const { data, error } = await supabase
      .from('host_media')
      .select('*')
      .eq('id', mediaId)
      .eq('host_kind', params.hostKind)
      .eq('host_id', params.hostId)
      .maybeSingle();

    if (error) {
      sendError(res, 500, 'fetch_failed', error.message);
      return;
    }
    if (!data) {
      sendError(res, 404, 'media_not_found', 'media not found');
      return;
    }
    res.status(200).json(withUrls(data));
  }

  // ────────────────────────────────────────────────────────────────────
  // POST /admin/<hostKind>/:hostId/media (multipart)
  // ────────────────────────────────────────────────────────────────────
  async function uploadMedia(req: RequestWithUser, res: Response): Promise<void> {
    const params = validateHostKindParam(req, res);
    if (!params) return;
    const { hostKind, hostId } = params;
    const userId = req.userId;
    if (!userId) {
      sendError(res, 401, 'unauthenticated', 'session required');
      return;
    }

    const consumer = getHostMediaConsumer(hostKind);
    if (!consumer) {
      sendError(res, 400, 'invalid_host_kind', `consumer not registered: ${hostKind}`);
      return;
    }

    // Rate-limit BEFORE parsing files so a flood of large requests can't
    // exhaust memory.
    const rlKey = buildRateLimitKey('upload', userId, hostKind, hostId);
    const rl = await rateLimit(rlKey, UPLOAD_RATE_LIMIT.max, UPLOAD_RATE_LIMIT.windowMs);
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil((rl.resetAt - Date.now()) / 1000).toString());
      sendError(res, 429, 'rate_limited', 'too many upload requests');
      return;
    }

    const files = await parseUploadedFiles(req);
    if (files.length === 0) {
      sendError(res, 400, 'no_files', 'at least one file required');
      return;
    }

    const albumId = paramAsUuid(req.body?.album_id);
    const caption = typeof req.body?.caption === 'string' ? req.body.caption.slice(0, 500) : null;

    const items: Array<{ filename: string; status: string; media_id?: string; cdn_url?: string; variants?: Record<string, string>; error?: string; message?: string }> = [];
    let anyFailed = false;

    for (const file of files) {
      // Class dispatch — image/video/audio/zip; reject unknown.
      const isImage = file.mimeType.startsWith('image/');
      const isVideo = file.mimeType.startsWith('video/');
      const isAudio = file.mimeType.startsWith('audio/');
      const isZip = file.mimeType === 'application/zip' || file.mimeType === 'application/x-zip-compressed';

      if (!isImage && !isVideo && !isAudio && !isZip) {
        items.push({ filename: file.filename, status: 'failed', error: 'unsupported_media_type', message: `mime ${file.mimeType} not allowed` });
        anyFailed = true;
        continue;
      }

      if (isZip && !consumer.enableZipUnpack) {
        items.push({ filename: file.filename, status: 'failed', error: 'zip_not_enabled', message: 'zip unpack disabled for this host_kind' });
        anyFailed = true;
        continue;
      }

      // Quota pre-flight (atomic reserve; we decrement on failure).
      const quotaResult = await supabase.rpc('host_media_quota_check', {
        p_host_kind: hostKind,
        p_host_id: hostId,
        p_requested_bytes: file.bytes,
      });
      const quotaOk = quotaResult.data?.ok === true;
      if (!quotaOk) {
        items.push({
          filename: file.filename,
          status: 'failed',
          error: 'quota_exceeded',
          message: 'host quota would be exceeded',
        });
        anyFailed = true;
        continue;
      }

      const mediaId = (globalThis.crypto?.randomUUID?.() ?? require('crypto').randomUUID()) as string;

      try {
        // Branch: video + YouTube delegation.
        // Instead of uploading to Storage and storing as a regular file,
        // hand the bytes to the media-upload-youtube edge fn which uploads
        // to YouTube via the Google API and returns the video metadata.
        // The host_media row's storage_path points to a synthetic path
        // (no actual storage object) and the youtube_* columns carry the
        // playable URL. If the YouTube call fails we fall back to native
        // storage so the user doesn't lose the bytes.
        let storagePath: string;
        let cdnUrl: string;
        let youtubeMeta: {
          video_id: string; url: string; embed_url: string; thumbnail_url: string;
        } | null = null;

        if (isVideo && consumer.enableYouTube) {
          try {
            const formData = new FormData();
            formData.append('video', new Blob([file.buffer], { type: file.mimeType }), file.filename);
            formData.append('title', file.filename.replace(/\.[^.]+$/, ''));
            formData.append('description', caption ?? '');
            formData.append('privacy', 'unlisted');
            const { data: ytRes, error: ytErr } = await supabase.functions.invoke('media-upload-youtube', { body: formData });
            if (ytErr || !ytRes?.video_id) {
              throw new Error(`youtube upload failed: ${ytErr?.message ?? 'no video_id returned'}`);
            }
            youtubeMeta = ytRes as { video_id: string; url: string; embed_url: string; thumbnail_url: string };
            // Synthesize a storage_path that records the YouTube provenance.
            // We don't actually upload to Storage for YouTube videos.
            storagePath = `${hostKind}/${hostId}/${mediaId}/youtube:${youtubeMeta.video_id}`;
            cdnUrl = youtubeMeta.url;
          } catch (ytErr) {
            logger.warn('YouTube delegation failed; falling back to native storage', {
              error: ytErr instanceof Error ? ytErr.message : String(ytErr),
              filename: file.filename,
            });
            const out = await mediaAdapter.upload({
              hostKind, hostId, mediaId,
              filename: file.filename, mimeType: file.mimeType, buffer: file.buffer,
            });
            storagePath = out.storagePath;
            cdnUrl = out.cdnUrl;
          }
        } else {
          const out = await mediaAdapter.upload({
            hostKind, hostId, mediaId,
            filename: file.filename, mimeType: file.mimeType, buffer: file.buffer,
          });
          storagePath = out.storagePath;
          cdnUrl = out.cdnUrl;
        }

        const insertRow: Record<string, unknown> = {
          id: mediaId,
          host_kind: hostKind,
          host_id: hostId,
          storage_path: storagePath,
          filename: sanitiseFilename(file.filename),
          mime_type: file.mimeType,
          bytes: file.bytes,
          uploaded_by: userId,
          access_level: 'public',
        };
        if (albumId && consumer.enableAlbums) insertRow['album_id'] = albumId;
        if (caption) insertRow['caption'] = caption;

        if (youtubeMeta) {
          insertRow['youtube_video_id']      = youtubeMeta.video_id;
          insertRow['youtube_url']           = youtubeMeta.url;
          insertRow['youtube_embed_url']     = youtubeMeta.embed_url;
          insertRow['youtube_thumbnail_url'] = youtubeMeta.thumbnail_url;
          insertRow['youtube_upload_status'] = 'completed';
          insertRow['youtube_uploaded_at']   = new Date().toISOString();
        } else if (isVideo && consumer.enableYouTube) {
          // Fallback path — native storage, mark as failed so a retry
          // worker can pick it up later.
          insertRow['youtube_upload_status'] = 'failed';
          insertRow['youtube_error_message'] = 'YouTube delegation failed at upload time; stored natively';
        }

        const inserted = await supabase
          .from('host_media')
          .insert(insertRow)
          .select()
          .single();

        if (inserted.error) {
          // Rollback: delete the storage object + decrement quota.
          try { await mediaAdapter.delete(storagePath); } catch { /* swallow */ }
          await supabase.rpc('host_media_quota_decrement', {
            p_host_kind: hostKind,
            p_host_id: hostId,
            p_bytes: file.bytes,
          });
          items.push({
            filename: file.filename,
            status: 'failed',
            error: 'db_error',
            message: inserted.error.message,
          });
          anyFailed = true;
          continue;
        }

        items.push({
          filename: file.filename,
          status: 'created',
          media_id: mediaId,
          cdn_url: cdnUrl,
        });
      } catch (err) {
        // Storage upload failed; quota was already reserved — release it.
        await supabase.rpc('host_media_quota_decrement', {
          p_host_kind: hostKind,
          p_host_id: hostId,
          p_bytes: file.bytes,
        });
        items.push({
          filename: file.filename,
          status: 'failed',
          error: 'upload_failed',
          message: err instanceof Error ? err.message : String(err),
        });
        anyFailed = true;
      }
    }

    res.status(anyFailed ? 207 : 200).json({ items });
  }

  // ────────────────────────────────────────────────────────────────────
  // PATCH /admin/<hostKind>/:hostId/media/:id
  // ────────────────────────────────────────────────────────────────────
  async function patchMedia(req: RequestWithUser, res: Response): Promise<void> {
    const params = validateHostKindParam(req, res);
    if (!params) return;
    const mediaId = paramAsUuid(req.params['id']);
    if (!mediaId) {
      sendError(res, 400, 'invalid_media_id', 'media id must be a UUID');
      return;
    }

    const picked = pickFields(req.body, MEDIA_PATCH_FIELDS);
    if (Object.keys(picked).length === 0) {
      sendError(res, 400, 'no_fields', 'at least one allowlisted field required');
      return;
    }
    const checked = validateMediaPatch(picked);
    if (!checked.ok) {
      sendError(res, 400, 'invalid_field', checked.error);
      return;
    }
    if (!(await albumIdIsValid(supabase, checked.value, params.hostKind, params.hostId))) {
      sendError(res, 400, 'invalid_album', 'album_id must be an album of this host');
      return;
    }

    const { data, error } = await supabase
      .from('host_media')
      .update(checked.value)
      .eq('id', mediaId)
      .eq('host_kind', params.hostKind)
      .eq('host_id', params.hostId)
      .select()
      .maybeSingle();

    if (error) {
      sendError(res, 500, 'update_failed', error.message);
      return;
    }
    if (!data) {
      sendError(res, 404, 'media_not_found', 'media not found');
      return;
    }
    res.status(200).json(withUrls(data));
  }

  // ────────────────────────────────────────────────────────────────────
  // PATCH /admin/<hostKind>/:hostId/media  { media_ids, fields }
  // Bulk edit (approve, hide, caption…) — same allowlist + validation as
  // the single PATCH, scoped to the host so foreign ids are ignored.
  // ────────────────────────────────────────────────────────────────────
  async function bulkPatchMedia(req: RequestWithUser, res: Response): Promise<void> {
    const params = validateHostKindParam(req, res);
    if (!params) return;
    const ids = parseUuidList(req.body?.media_ids);
    if (!ids) {
      sendError(res, 400, 'invalid_media_ids', 'media_ids must be 1-500 UUIDs');
      return;
    }
    const picked = pickFields(req.body?.fields, MEDIA_PATCH_FIELDS);
    if (Object.keys(picked).length === 0) {
      sendError(res, 400, 'no_fields', 'at least one allowlisted field required');
      return;
    }
    const checked = validateMediaPatch(picked);
    if (!checked.ok) {
      sendError(res, 400, 'invalid_field', checked.error);
      return;
    }
    if (!(await albumIdIsValid(supabase, checked.value, params.hostKind, params.hostId))) {
      sendError(res, 400, 'invalid_album', 'album_id must be an album of this host');
      return;
    }

    const { data, error } = await supabase
      .from('host_media')
      .update(checked.value)
      .in('id', ids)
      .eq('host_kind', params.hostKind)
      .eq('host_id', params.hostId)
      .select('id');
    if (error) {
      sendError(res, 500, 'update_failed', error.message);
      return;
    }
    res.status(200).json({ updated: (data ?? []).map((r: { id: string }) => r.id) });
  }

  // ────────────────────────────────────────────────────────────────────
  // POST /admin/<hostKind>/:hostId/media/bulk-delete  { media_ids }
  // Deletes every id that belongs to the host and is not referenced;
  // referenced rows are reported back, never deleted.
  // ────────────────────────────────────────────────────────────────────
  async function bulkDeleteMedia(req: RequestWithUser, res: Response): Promise<void> {
    const params = validateHostKindParam(req, res);
    if (!params) return;
    const ids = parseUuidList(req.body?.media_ids);
    if (!ids) {
      sendError(res, 400, 'invalid_media_ids', 'media_ids must be 1-500 UUIDs');
      return;
    }

    const { data: rows, error: fetchErr } = await supabase
      .from('host_media')
      .select('id, storage_path, variants, bytes, used_in')
      .in('id', ids)
      .eq('host_kind', params.hostKind)
      .eq('host_id', params.hostId);
    if (fetchErr) { sendError(res, 500, 'fetch_failed', fetchErr.message); return; }

    interface DelRow { id: string; storage_path: string; variants: unknown; bytes: number; used_in: unknown }
    const found = (rows ?? []) as DelRow[];
    const inUse = found.filter((r) => Array.isArray(r.used_in) && r.used_in.length > 0);
    const deletable = found.filter((r) => !inUse.includes(r));

    if (deletable.length > 0) {
      const { error: delErr } = await supabase
        .from('host_media')
        .delete()
        .in('id', deletable.map((r) => r.id))
        .eq('host_kind', params.hostKind)
        .eq('host_id', params.hostId);
      if (delErr) { sendError(res, 500, 'delete_failed', delErr.message); return; }

      for (const r of deletable) {
        for (const path of ownedStoragePaths(r)) {
          try { await mediaAdapter.delete(path); } catch (err) {
            logger.warn('host_media storage delete failed (row already deleted)', {
              mediaId: r.id,
              storagePath: path,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        await supabase.rpc('host_media_quota_decrement', {
          p_host_kind: params.hostKind,
          p_host_id: params.hostId,
          p_bytes: r.bytes,
        });
      }
    }

    const foundIds = new Set(found.map((r) => r.id));
    res.status(200).json({
      deleted: deletable.map((r) => r.id),
      in_use: inUse.map((r) => r.id),
      not_found: ids.filter((id) => !foundIds.has(id)),
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // PUT /admin/<hostKind>/:hostId/media/order  { media_ids }
  // Rewrites the host-wide custom order from an ordered id list.
  // ────────────────────────────────────────────────────────────────────
  async function setMediaOrder(req: RequestWithUser, res: Response): Promise<void> {
    const params = validateHostKindParam(req, res);
    if (!params) return;
    const ids = parseUuidList(req.body?.media_ids, 5000);
    if (!ids) {
      sendError(res, 400, 'invalid_media_ids', 'media_ids must be 1-5000 UUIDs');
      return;
    }
    const { data, error } = await supabase.rpc('host_media_set_display_order', {
      p_host_kind: params.hostKind,
      p_host_id: params.hostId,
      p_ids: ids,
    });
    if (error) { sendError(res, 500, 'order_failed', error.message); return; }
    res.status(200).json({ updated: typeof data === 'number' ? data : 0 });
  }

  // ────────────────────────────────────────────────────────────────────
  // DELETE /admin/<hostKind>/:hostId/media/:id
  // ────────────────────────────────────────────────────────────────────
  async function deleteMedia(req: RequestWithUser, res: Response): Promise<void> {
    const params = validateHostKindParam(req, res);
    if (!params) return;
    const mediaId = paramAsUuid(req.params['id']);
    if (!mediaId) {
      sendError(res, 400, 'invalid_media_id', 'media id must be a UUID');
      return;
    }

    // Look up first so we can refuse if used_in.length > 0 + delete the
    // storage object after the row.
    const { data: item, error: fetchErr } = await supabase
      .from('host_media')
      .select('id, storage_path, variants, bytes, used_in')
      .eq('id', mediaId)
      .eq('host_kind', params.hostKind)
      .eq('host_id', params.hostId)
      .maybeSingle();

    if (fetchErr) { sendError(res, 500, 'fetch_failed', fetchErr.message); return; }
    if (!item) { sendError(res, 404, 'media_not_found', 'media not found'); return; }
    const usedIn = Array.isArray(item.used_in) ? item.used_in : [];
    if (usedIn.length > 0) {
      sendError(res, 409, 'media_in_use', `media is referenced by ${usedIn.length} item(s)`, { used_in: usedIn });
      return;
    }

    const { error: delErr } = await supabase.from('host_media').delete().eq('id', mediaId);
    if (delErr) { sendError(res, 500, 'delete_failed', delErr.message); return; }

    for (const path of ownedStoragePaths(item)) {
      try { await mediaAdapter.delete(path); } catch (err) {
        logger.warn('host_media storage delete failed (row already deleted)', {
          mediaId,
          storagePath: path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await supabase.rpc('host_media_quota_decrement', {
      p_host_kind: params.hostKind,
      p_host_id: params.hostId,
      p_bytes: item.bytes,
    });

    res.status(204).end();
  }

  // ────────────────────────────────────────────────────────────────────
  // GET /admin/<hostKind>/:hostId/media/:id/contents
  // Origin-gated streaming for access_level='authenticated' assets.
  // For public assets, the client should use cdn_url directly.
  // ────────────────────────────────────────────────────────────────────
  async function streamMediaContents(req: RequestWithUser, res: Response): Promise<void> {
    const params = validateHostKindParam(req, res);
    if (!params) return;
    const mediaId = paramAsUuid(req.params['id']);
    if (!mediaId) { sendError(res, 400, 'invalid_media_id', 'media id must be a UUID'); return; }

    const { data: item, error } = await supabase
      .from('host_media')
      .select('id, storage_path, mime_type, bytes')
      .eq('id', mediaId)
      .eq('host_kind', params.hostKind)
      .eq('host_id', params.hostId)
      .maybeSingle();

    if (error) { sendError(res, 500, 'fetch_failed', error.message); return; }
    if (!item) { sendError(res, 404, 'media_not_found', 'media not found'); return; }

    // Use a short-lived signed URL internally to download bytes and
    // pipe them through. Adds a hop but keeps the CDN URL out of
    // browser history / cache for authenticated assets.
    const signedUrl = await mediaAdapter.createSignedUrl(item.storage_path, 60);
    const upstream = await fetch(signedUrl);
    if (!upstream.ok) {
      sendError(res, 500, 'stream_failed', `upstream returned ${upstream.status}`);
      return;
    }
    res.setHeader('Content-Type', item.mime_type);
    res.setHeader('Content-Length', item.bytes.toString());
    res.setHeader('Cache-Control', 'private, no-store');
    if (upstream.body) {
      // Node 18+ supports ReadableStream; pipe bytes through.
      const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } else {
      res.end();
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // POST /admin/<hostKind>/:hostId/media/:id/signed-url
  // Issue a 1-hour signed URL for access_level='signed' assets +
  // log to host_media_signed_url_log.
  // ────────────────────────────────────────────────────────────────────
  async function issueSignedUrl(req: RequestWithUser, res: Response): Promise<void> {
    const params = validateHostKindParam(req, res);
    if (!params) return;
    const mediaId = paramAsUuid(req.params['id']);
    if (!mediaId) { sendError(res, 400, 'invalid_media_id', 'media id must be a UUID'); return; }
    const userId = req.userId;
    if (!userId) { sendError(res, 401, 'unauthenticated', 'session required'); return; }

    const rlKey = buildRateLimitKey('signed_url', userId, params.hostKind, params.hostId);
    const rl = await rateLimit(rlKey, SIGNED_URL_RATE_LIMIT.max, SIGNED_URL_RATE_LIMIT.windowMs);
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil((rl.resetAt - Date.now()) / 1000).toString());
      sendError(res, 429, 'rate_limited', 'too many signed-URL requests');
      return;
    }

    const { data: item, error } = await supabase
      .from('host_media')
      .select('id, storage_path, access_level')
      .eq('id', mediaId)
      .eq('host_kind', params.hostKind)
      .eq('host_id', params.hostId)
      .maybeSingle();

    if (error) { sendError(res, 500, 'fetch_failed', error.message); return; }
    if (!item) { sendError(res, 404, 'media_not_found', 'media not found'); return; }

    const ttl = 3600;
    const signedUrl = await mediaAdapter.createSignedUrl(item.storage_path, ttl);

    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    await supabase.from('host_media_signed_url_log').insert({
      media_id: mediaId,
      minted_by: userId,
      ttl_seconds: ttl,
      expires_at: expiresAt,
      ip_cidr: req.ip ?? null,
      user_agent: req.headers['user-agent'] ?? null,
    });

    res.status(200).json({ signed_url: signedUrl, expires_at: expiresAt });
  }

  return {
    listMedia,
    getMedia,
    uploadMedia,
    patchMedia,
    bulkPatchMedia,
    bulkDeleteMedia,
    setMediaOrder,
    deleteMedia,
    streamMediaContents,
    issueSignedUrl,
  };
}

/**
 * `authorize` runs before every handler (and before multer on upload, so
 * an unauthorized caller never gets to stream bytes into memory). The
 * static `/media/order` + `/media/bulk-delete` paths are registered
 * before `/media/:id` so they are not captured as an id.
 */
export function mountMediaRoutes(
  router: Router,
  routes: ReturnType<typeof createMediaRoutes>,
  uploadMiddleware: import('express').RequestHandler | undefined,
  authorize: import('express').RequestHandler,
): void {
  router.get('/:hostKind/:hostId/media', authorize, routes.listMedia);
  if (uploadMiddleware) {
    router.post('/:hostKind/:hostId/media', authorize, uploadMiddleware, routes.uploadMedia);
  } else {
    router.post('/:hostKind/:hostId/media', authorize, routes.uploadMedia);
  }
  router.patch('/:hostKind/:hostId/media', authorize, routes.bulkPatchMedia);
  router.put('/:hostKind/:hostId/media/order', authorize, routes.setMediaOrder);
  router.post('/:hostKind/:hostId/media/bulk-delete', authorize, routes.bulkDeleteMedia);
  router.get('/:hostKind/:hostId/media/:id', authorize, routes.getMedia);
  router.get('/:hostKind/:hostId/media/:id/contents', authorize, routes.streamMediaContents);
  router.patch('/:hostKind/:hostId/media/:id', authorize, routes.patchMedia);
  router.delete('/:hostKind/:hostId/media/:id', authorize, routes.deleteMedia);
  router.post('/:hostKind/:hostId/media/:id/signed-url', authorize, routes.issueSignedUrl);
}
