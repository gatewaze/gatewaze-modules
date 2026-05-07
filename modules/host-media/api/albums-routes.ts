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
import { paramAsUuid, paramAsString, pickFields } from '../lib/sanitisers.js';
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

export function createAlbumsRoutes(deps: AlbumsRoutesDeps) {
  const { supabase, logger } = deps;

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
    const fields = pickFields(req.body, ALBUM_WRITE_FIELDS);
    if (typeof fields['name'] !== 'string' || fields['name'].length === 0) {
      sendError(res, 400, 'missing_name', 'album name required');
      return;
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
    const fields = pickFields(req.body, ALBUM_WRITE_FIELDS);
    if (Object.keys(fields).length === 0) {
      sendError(res, 400, 'no_fields', 'at least one allowlisted field required');
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

  async function addItemToAlbum(req: RequestWithUser, res: Response): Promise<void> {
    const c = checkHost(req, res); if (!c) return;
    const albumId = paramAsUuid(req.params['id']);
    const mediaId = paramAsUuid(req.body?.media_id);
    if (!albumId || !mediaId) {
      sendError(res, 400, 'invalid_params', 'album id + media_id (UUID) required');
      return;
    }
    const sortOrder = Number(req.body?.sort_order ?? 0);
    const { data, error } = await supabase
      .from('host_media_album_items')
      .insert({ album_id: albumId, media_id: mediaId, sort_order: sortOrder })
      .select().single();
    if (error) {
      // Probably the unique-constraint — friendlier message.
      if (/duplicate key/.test(error.message)) {
        sendError(res, 409, 'already_in_album', 'media already in this album');
        return;
      }
      sendError(res, 500, 'insert_failed', error.message);
      return;
    }
    res.status(201).json(data);
  }

  async function removeItemFromAlbum(req: RequestWithUser, res: Response): Promise<void> {
    const c = checkHost(req, res); if (!c) return;
    const albumId = paramAsUuid(req.params['id']);
    const mediaId = paramAsUuid(req.params['mediaId']);
    if (!albumId || !mediaId) {
      sendError(res, 400, 'invalid_params', 'album id + media id (UUID) required');
      return;
    }
    const { error } = await supabase
      .from('host_media_album_items')
      .delete()
      .eq('album_id', albumId).eq('media_id', mediaId);
    if (error) { sendError(res, 500, 'delete_failed', error.message); return; }
    res.status(204).end();
  }

  return { listAlbums, createAlbum, patchAlbum, deleteAlbum, addItemToAlbum, removeItemFromAlbum };
}

export function mountAlbumsRoutes(router: Router, routes: ReturnType<typeof createAlbumsRoutes>): void {
  router.get('/:hostKind/:hostId/albums', routes.listAlbums);
  router.post('/:hostKind/:hostId/albums', routes.createAlbum);
  router.patch('/:hostKind/:hostId/albums/:id', routes.patchAlbum);
  router.delete('/:hostKind/:hostId/albums/:id', routes.deleteAlbum);
  router.post('/:hostKind/:hostId/albums/:id/items', routes.addItemToAlbum);
  router.delete('/:hostKind/:hostId/albums/:id/items/:mediaId', routes.removeItemFromAlbum);
}
