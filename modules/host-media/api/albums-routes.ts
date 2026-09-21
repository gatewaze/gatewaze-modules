// @ts-nocheck — see routes.ts header.

/**
 * Album CRUD + album-item add/remove. Mounted only when at least one
 * registered consumer has enableAlbums: true; otherwise the routes are
 * still mounted but every call returns 400 invalid_host_kind via the
 * routes.ts validation (consumer's enableAlbums flag also gates UI).
 *
 * Per spec-host-media-module §4.3 + §5.
 */

import type { Request, Response, Router } from 'express';
import { isKnownHostKind, getHostMediaConsumer } from '../lib/registry.js';
import { paramAsUuid, paramAsString, pickFields, parseUuidList } from '../lib/sanitisers.js';
import { ALBUM_WRITE_FIELDS } from '../types/index.js';

interface RequestWithUser extends Request {
  userId?: string;
}

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface AlbumsRoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  logger: PlatformLogger;
}

function sendError(res: Response, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  const body: Record<string, unknown> = { error: code, message };
  if (details) body['details'] = details;
  res.status(status).json(body);
}

function checkHost(req: Request, res: Response): { hostKind: string; hostId: string; albumsEnabled: boolean } | null {
  const hostKind = paramAsString(req.params['hostKind']);
  const hostId = paramAsUuid(req.params['hostId']);
  if (!hostKind) { sendError(res, 400, 'missing_params', 'hostKind required'); return null; }
  if (!hostId) { sendError(res, 400, 'invalid_host_id', 'hostId must be a UUID'); return null; }
  if (!isKnownHostKind(hostKind)) {
    sendError(res, 400, 'invalid_host_kind', `unknown host_kind: ${hostKind}`);
    return null;
  }
  const consumer = getHostMediaConsumer(hostKind);
  return { hostKind, hostId, albumsEnabled: consumer?.enableAlbums === true };
}

/**
 * Type-checks the album write fields pickFields() let through. Returns
 * the cleaned object or an error string.
 */
function validateAlbumFields(
  fields: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const value: Record<string, unknown> = {};
  // Iterate the fixed allowlist, never the caller's keys, so every
  // written property name is a literal from ALBUM_WRITE_FIELDS.
  for (const key of ALBUM_WRITE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    const raw = fields[key];
    switch (key) {
      case 'name':
        if (typeof raw !== 'string' || raw.trim().length === 0) return { ok: false, error: 'name must be a non-empty string' };
        value[key] = raw.trim().slice(0, 200);
        break;
      case 'description':
        if (raw !== null && typeof raw !== 'string') return { ok: false, error: 'description must be a string or null' };
        value[key] = typeof raw === 'string' ? (raw.trim().slice(0, 2000) || null) : null;
        break;
      case 'cover_media_id':
        if (raw !== null && !paramAsUuid(raw)) return { ok: false, error: 'cover_media_id must be a UUID or null' };
        value[key] = raw;
        break;
      case 'sort_order':
        if (!Number.isInteger(raw)) return { ok: false, error: 'sort_order must be an integer' };
        value[key] = raw;
        break;
      case 'is_default':
        if (typeof raw !== 'boolean') return { ok: false, error: 'is_default must be a boolean' };
        value[key] = raw;
        break;
    }
  }
  for (const key of Object.keys(fields)) {
    if (!(ALBUM_WRITE_FIELDS as readonly string[]).includes(key)) return { ok: false, error: `unknown field ${key}` };
  }
  return { ok: true, value };
}

export function createAlbumsRoutes(deps: AlbumsRoutesDeps) {
  const { supabase, logger } = deps;

  /** True when the album exists and belongs to the host in the URL. */
  async function albumBelongsToHost(albumId: string, hostKind: string, hostId: string): Promise<boolean> {
    const { data } = await supabase
      .from('host_media_albums')
      .select('id')
      .eq('id', albumId).eq('host_kind', hostKind).eq('host_id', hostId)
      .maybeSingle();
    return !!data;
  }

  /** The subset of `ids` that are media rows of the host in the URL. */
  async function mediaOfHost(ids: string[], hostKind: string, hostId: string): Promise<string[]> {
    const { data } = await supabase
      .from('host_media')
      .select('id')
      .in('id', ids)
      .eq('host_kind', hostKind).eq('host_id', hostId);
    return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  }

  /** A cover must be media of the same host (null clears it). */
  async function coverIsValid(fields: Record<string, unknown>, hostKind: string, hostId: string): Promise<boolean> {
    if (!('cover_media_id' in fields) || fields['cover_media_id'] === null) return true;
    const ok = await mediaOfHost([fields['cover_media_id'] as string], hostKind, hostId);
    return ok.length === 1;
  }

  async function listAlbums(req: RequestWithUser, res: Response): Promise<void> {
    const c = checkHost(req, res); if (!c) return;
    const { data, error } = await supabase
      .from('host_media_albums')
      .select('*')
      .eq('host_kind', c.hostKind).eq('host_id', c.hostId)
      .order('sort_order', { ascending: true });
    if (error) { sendError(res, 500, 'list_failed', error.message); return; }
    res.status(200).json({ albums: data ?? [] });
  }

  async function createAlbum(req: RequestWithUser, res: Response): Promise<void> {
    const c = checkHost(req, res); if (!c) return;
    if (!c.albumsEnabled) {
      sendError(res, 400, 'albums_disabled', `albums not enabled for host_kind=${c.hostKind}`);
      return;
    }
    const picked = pickFields(req.body, ALBUM_WRITE_FIELDS);
    if (typeof picked['name'] !== 'string' || picked['name'].trim().length === 0) {
      sendError(res, 400, 'missing_name', 'album name required');
      return;
    }
    const checked = validateAlbumFields(picked);
    if (!checked.ok) { sendError(res, 400, 'invalid_field', checked.error); return; }
    const fields = checked.value;
    if (!(await coverIsValid(fields, c.hostKind, c.hostId))) {
      sendError(res, 400, 'invalid_cover', 'cover_media_id must be media of this host');
      return;
    }
    // New albums go after the existing ones unless a position was given.
    if (!('sort_order' in fields)) {
      const { data: last } = await supabase
        .from('host_media_albums')
        .select('sort_order')
        .eq('host_kind', c.hostKind).eq('host_id', c.hostId)
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle();
      fields['sort_order'] = ((last?.sort_order as number | undefined) ?? 0) + 10;
    }
    const { data, error } = await supabase
      .from('host_media_albums')
      .insert({ ...fields, host_kind: c.hostKind, host_id: c.hostId })
      .select().single();
    if (error) {
      logger.error('host_media_albums insert failed', { error: error.message });
      sendError(res, 500, 'create_failed', error.message);
      return;
    }
    res.status(201).json(data);
  }

  async function patchAlbum(req: RequestWithUser, res: Response): Promise<void> {
    const c = checkHost(req, res); if (!c) return;
    const albumId = paramAsUuid(req.params['id']);
    if (!albumId) { sendError(res, 400, 'invalid_album_id', 'album id must be a UUID'); return; }
    const picked = pickFields(req.body, ALBUM_WRITE_FIELDS);
    if (Object.keys(picked).length === 0) {
      sendError(res, 400, 'no_fields', 'at least one allowlisted field required');
      return;
    }
    const checked = validateAlbumFields(picked);
    if (!checked.ok) { sendError(res, 400, 'invalid_field', checked.error); return; }
    const fields = checked.value;
    if (!(await coverIsValid(fields, c.hostKind, c.hostId))) {
      sendError(res, 400, 'invalid_cover', 'cover_media_id must be media of this host');
      return;
    }
    const { data, error } = await supabase
      .from('host_media_albums')
      .update(fields)
      .eq('id', albumId).eq('host_kind', c.hostKind).eq('host_id', c.hostId)
      .select().maybeSingle();
    if (error) { sendError(res, 500, 'update_failed', error.message); return; }
    if (!data) { sendError(res, 404, 'album_not_found', 'album not found'); return; }
    res.status(200).json(data);
  }

  async function deleteAlbum(req: RequestWithUser, res: Response): Promise<void> {
    const c = checkHost(req, res); if (!c) return;
    const albumId = paramAsUuid(req.params['id']);
    if (!albumId) { sendError(res, 400, 'invalid_album_id', 'album id must be a UUID'); return; }
    const { error } = await supabase
      .from('host_media_albums')
      .delete()
      .eq('id', albumId).eq('host_kind', c.hostKind).eq('host_id', c.hostId);
    if (error) { sendError(res, 500, 'delete_failed', error.message); return; }
    res.status(204).end();
  }

  // GET /:hostKind/:hostId/album-items — every album membership for the
  // host, so the organizer can show album chips and filter client-side.
  async function listAlbumItems(req: RequestWithUser, res: Response): Promise<void> {
    const c = checkHost(req, res); if (!c) return;
    const { data: albums, error: albumsErr } = await supabase
      .from('host_media_albums')
      .select('id')
      .eq('host_kind', c.hostKind).eq('host_id', c.hostId);
    if (albumsErr) { sendError(res, 500, 'list_failed', albumsErr.message); return; }
    const albumIds = ((albums ?? []) as Array<{ id: string }>).map((a) => a.id);
    if (albumIds.length === 0) { res.status(200).json({ items: [] }); return; }
    const { data, error } = await supabase
      .from('host_media_album_items')
      .select('id, album_id, media_id, sort_order')
      .in('album_id', albumIds)
      .order('sort_order', { ascending: true });
    if (error) { sendError(res, 500, 'list_failed', error.message); return; }
    res.status(200).json({ items: data ?? [] });
  }

  // POST /:hostKind/:hostId/albums/:id/items — body { media_id } or
  // { media_ids: [...] }. Items already in the album are skipped; new
  // ones are appended after the album's current last item.
  async function addItemToAlbum(req: RequestWithUser, res: Response): Promise<void> {
    const c = checkHost(req, res); if (!c) return;
    const albumId = paramAsUuid(req.params['id']);
    const single = paramAsUuid(req.body?.media_id);
    const ids = req.body?.media_ids !== undefined ? parseUuidList(req.body.media_ids) : (single ? [single] : null);
    if (!albumId || !ids) {
      sendError(res, 400, 'invalid_params', 'album id + media_id or media_ids (UUIDs) required');
      return;
    }
    if (!(await albumBelongsToHost(albumId, c.hostKind, c.hostId))) {
      sendError(res, 404, 'album_not_found', 'album not found');
      return;
    }
    const valid = await mediaOfHost(ids, c.hostKind, c.hostId);
    if (valid.length === 0) {
      sendError(res, 404, 'media_not_found', 'no media of this host in media_ids');
      return;
    }

    const { data: existing } = await supabase
      .from('host_media_album_items')
      .select('media_id, sort_order')
      .eq('album_id', albumId);
    const existingRows = (existing ?? []) as Array<{ media_id: string; sort_order: number }>;
    const already = new Set(existingRows.map((r) => r.media_id));
    let next = existingRows.reduce((max, r) => Math.max(max, r.sort_order ?? 0), 0);
    const rows = valid
      .filter((id) => !already.has(id))
      .map((id) => ({ album_id: albumId, media_id: id, sort_order: (next += 10) }));

    if (rows.length > 0) {
      const { error } = await supabase
        .from('host_media_album_items')
        .upsert(rows, { onConflict: 'album_id,media_id', ignoreDuplicates: true });
      if (error) { sendError(res, 500, 'insert_failed', error.message); return; }
    }
    res.status(201).json({
      added: rows.map((r) => r.media_id),
      already_in_album: valid.filter((id) => already.has(id)),
    });
  }

  // PUT /:hostKind/:hostId/albums/:id/order — body { media_ids } in the
  // desired order; rewrites the album's sort_order in one statement.
  async function setAlbumOrder(req: RequestWithUser, res: Response): Promise<void> {
    const c = checkHost(req, res); if (!c) return;
    const albumId = paramAsUuid(req.params['id']);
    const ids = parseUuidList(req.body?.media_ids, 5000);
    if (!albumId || !ids) {
      sendError(res, 400, 'invalid_params', 'album id + media_ids (1-5000 UUIDs) required');
      return;
    }
    if (!(await albumBelongsToHost(albumId, c.hostKind, c.hostId))) {
      sendError(res, 404, 'album_not_found', 'album not found');
      return;
    }
    const { data, error } = await supabase.rpc('host_media_set_album_order', {
      p_album_id: albumId,
      p_ids: ids,
    });
    if (error) { sendError(res, 500, 'order_failed', error.message); return; }
    res.status(200).json({ updated: typeof data === 'number' ? data : 0 });
  }

  async function removeItemFromAlbum(req: RequestWithUser, res: Response): Promise<void> {
    const c = checkHost(req, res); if (!c) return;
    const albumId = paramAsUuid(req.params['id']);
    const mediaId = paramAsUuid(req.params['mediaId']);
    if (!albumId || !mediaId) {
      sendError(res, 400, 'invalid_params', 'album id + media id (UUID) required');
      return;
    }
    if (!(await albumBelongsToHost(albumId, c.hostKind, c.hostId))) {
      sendError(res, 404, 'album_not_found', 'album not found');
      return;
    }
    const { error } = await supabase
      .from('host_media_album_items')
      .delete()
      .eq('album_id', albumId).eq('media_id', mediaId);
    if (error) { sendError(res, 500, 'delete_failed', error.message); return; }
    res.status(204).end();
  }

  return { listAlbums, createAlbum, patchAlbum, deleteAlbum, listAlbumItems, addItemToAlbum, setAlbumOrder, removeItemFromAlbum };
}

export function mountAlbumsRoutes(
  router: Router,
  routes: ReturnType<typeof createAlbumsRoutes>,
  authorize: import('express').RequestHandler,
): void {
  router.get('/:hostKind/:hostId/albums', authorize, routes.listAlbums);
  router.post('/:hostKind/:hostId/albums', authorize, routes.createAlbum);
  router.get('/:hostKind/:hostId/album-items', authorize, routes.listAlbumItems);
  router.patch('/:hostKind/:hostId/albums/:id', authorize, routes.patchAlbum);
  router.delete('/:hostKind/:hostId/albums/:id', authorize, routes.deleteAlbum);
  router.post('/:hostKind/:hostId/albums/:id/items', authorize, routes.addItemToAlbum);
  router.put('/:hostKind/:hostId/albums/:id/order', authorize, routes.setAlbumOrder);
  router.delete('/:hostKind/:hostId/albums/:id/items/:mediaId', authorize, routes.removeItemFromAlbum);
}
