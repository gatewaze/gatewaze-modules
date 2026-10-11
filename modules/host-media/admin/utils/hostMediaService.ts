/**
 * Browser-side fetch wrappers — every call passes a Bearer JWT from
 * the user's Supabase session. Apr-2026: the platform's portal +
 * admin both use this pattern; the alternative (cookie auth) is the
 * SSR portal path only.
 */

import { supabase } from '@/lib/supabase';
import type { HostMediaItem } from '../../client-types';

async function authedFetch(input: string, init?: RequestInit): Promise<Response> {
  const apiUrl = (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${apiUrl}${input}`, { ...init, headers });
}

export async function listHostMedia(
  hostKind: string,
  hostId: string,
  opts: { filter?: 'all' | 'photo' | 'video' | 'audio'; album_id?: string; search?: string; limit?: number; offset?: number } = {},
): Promise<Response> {
  const qs = new URLSearchParams();
  if (opts.filter && opts.filter !== 'all') qs.set('filter', opts.filter);
  if (opts.album_id) qs.set('album_id', opts.album_id);
  if (opts.search) qs.set('search', opts.search);
  if (opts.limit) qs.set('limit', String(opts.limit));
  if (opts.offset) qs.set('offset', String(opts.offset));
  const query = qs.toString();
  return authedFetch(`/api/admin/${hostKind}/${hostId}/media${query ? `?${query}` : ''}`);
}

export async function uploadHostMedia(
  hostKind: string,
  hostId: string,
  files: FileList | File[],
  opts: { album_id?: string; caption?: string } = {},
): Promise<Response> {
  const fd = new FormData();
  Array.from(files).forEach((f) => fd.append('files', f));
  if (opts.album_id) fd.append('album_id', opts.album_id);
  if (opts.caption) fd.append('caption', opts.caption);
  return authedFetch(`/api/admin/${hostKind}/${hostId}/media`, { method: 'POST', body: fd });
}

export async function deleteHostMedia(hostKind: string, hostId: string, mediaId: string): Promise<Response> {
  return authedFetch(`/api/admin/${hostKind}/${hostId}/media/${mediaId}`, { method: 'DELETE' });
}

export async function patchHostMedia(
  hostKind: string,
  hostId: string,
  mediaId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return authedFetch(`/api/admin/${hostKind}/${hostId}/media/${mediaId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function listAlbums(hostKind: string, hostId: string): Promise<Response> {
  return authedFetch(`/api/admin/${hostKind}/${hostId}/albums`);
}

export async function createAlbum(hostKind: string, hostId: string, body: { name: string; description?: string }): Promise<Response> {
  return authedFetch(`/api/admin/${hostKind}/${hostId}/albums`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function deleteAlbum(hostKind: string, hostId: string, albumId: string): Promise<Response> {
  return authedFetch(`/api/admin/${hostKind}/${hostId}/albums/${albumId}`, { method: 'DELETE' });
}

export async function addToAlbum(hostKind: string, hostId: string, albumId: string, mediaId: string): Promise<Response> {
  return authedFetch(`/api/admin/${hostKind}/${hostId}/albums/${albumId}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_id: mediaId }),
  });
}

export async function removeFromAlbum(hostKind: string, hostId: string, albumId: string, mediaId: string): Promise<Response> {
  return authedFetch(`/api/admin/${hostKind}/${hostId}/albums/${albumId}/items/${mediaId}`, { method: 'DELETE' });
}

async function jsonCall(method: string, path: string, body?: unknown): Promise<Response> {
  return authedFetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * Reads every media row for a host by following next_cursor (500 per
 * page). The organizer needs the whole set in memory for client-side
 * sort, album/sponsor filtering and drag reordering.
 */
export async function listAllHostMedia(hostKind: string, hostId: string): Promise<HostMediaItem[]> {
  const all: HostMediaItem[] = [];
  let offset = 0;
  // Hard stop well past any realistic host so a server bug cannot loop forever.
  for (let page = 0; page < 40; page++) {
    const resp = await listHostMedia(hostKind, hostId, { limit: 500, offset });
    if (!resp.ok) throw new Error(await errorMessage(resp, 'Failed to load media'));
    const body = (await resp.json()) as { items: HostMediaItem[]; next_cursor: string | null };
    all.push(...(body.items ?? []));
    if (!body.next_cursor) break;
    offset = Number(body.next_cursor);
  }
  return all;
}

export async function errorMessage(resp: Response, fallback: string): Promise<string> {
  try {
    const body = (await resp.json()) as { message?: string };
    return body.message ?? fallback;
  } catch {
    return fallback;
  }
}

export async function bulkPatchHostMedia(
  hostKind: string,
  hostId: string,
  mediaIds: string[],
  fields: Record<string, unknown>,
): Promise<Response> {
  return jsonCall('PATCH', `/api/admin/${hostKind}/${hostId}/media`, { media_ids: mediaIds, fields });
}

export async function bulkDeleteHostMedia(hostKind: string, hostId: string, mediaIds: string[]): Promise<Response> {
  return jsonCall('POST', `/api/admin/${hostKind}/${hostId}/media/bulk-delete`, { media_ids: mediaIds });
}

export async function setHostMediaOrder(hostKind: string, hostId: string, mediaIds: string[]): Promise<Response> {
  return jsonCall('PUT', `/api/admin/${hostKind}/${hostId}/media/order`, { media_ids: mediaIds });
}

export async function updateAlbum(
  hostKind: string,
  hostId: string,
  albumId: string,
  body: { name?: string; description?: string | null; cover_media_id?: string | null; sort_order?: number },
): Promise<Response> {
  return jsonCall('PATCH', `/api/admin/${hostKind}/${hostId}/albums/${albumId}`, body);
}

export async function listAlbumItems(hostKind: string, hostId: string): Promise<Response> {
  return authedFetch(`/api/admin/${hostKind}/${hostId}/album-items`);
}

export async function addManyToAlbum(hostKind: string, hostId: string, albumId: string, mediaIds: string[]): Promise<Response> {
  return jsonCall('POST', `/api/admin/${hostKind}/${hostId}/albums/${albumId}/items`, { media_ids: mediaIds });
}

export async function setAlbumOrder(hostKind: string, hostId: string, albumId: string, mediaIds: string[]): Promise<Response> {
  return jsonCall('PUT', `/api/admin/${hostKind}/${hostId}/albums/${albumId}/order`, { media_ids: mediaIds });
}

export async function getHostMedia(hostKind: string, hostId: string, mediaId: string): Promise<Response> {
  return authedFetch(`/api/admin/${hostKind}/${hostId}/media/${mediaId}`);
}
