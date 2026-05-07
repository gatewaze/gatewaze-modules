/**
 * Browser-side fetch wrappers — every call passes a Bearer JWT from
 * the user's Supabase session. Apr-2026: the platform's portal +
 * admin both use this pattern; the alternative (cookie auth) is the
 * SSR portal path only.
 */

import { supabase } from '@/lib/supabase';

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
  opts: { filter?: 'all' | 'photo' | 'video' | 'audio'; album_id?: string; search?: string; limit?: number } = {},
): Promise<Response> {
  const qs = new URLSearchParams();
  if (opts.filter && opts.filter !== 'all') qs.set('filter', opts.filter);
  if (opts.album_id) qs.set('album_id', opts.album_id);
  if (opts.search) qs.set('search', opts.search);
  if (opts.limit) qs.set('limit', String(opts.limit));
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
