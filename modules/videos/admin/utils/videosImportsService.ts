/**
 * Admin-side client for the importers, /api/modules/videos/imports/*.
 *
 * Separate from videosEditorService because that one talks to the editor
 * prefix, which has no admin gate; this prefix is operator-only. Named
 * distinctively for the same reason as its sibling: every
 * `<module>/admin/utils/<name>.ts` becomes a global `@/utils/<name>` alias.
 */

import { supabase } from '@/lib/supabase';

function apiUrl(): string {
  return (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
}

async function authedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  const res = await fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      detail = body.message || body.error || detail;
    } catch {
      /* non-JSON error page */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

const BASE = '/api/modules/videos/imports';

export interface QueuedImport {
  queued: boolean;
  job_id: string | null;
  recap_id?: string;
  event_id?: string;
  folder_id?: string;
}

export interface ImportedAsset {
  id: string;
  video_id: string;
  kind: string;
  state: 'uploading' | 'ready' | 'failed' | 'superseded';
  bytes: number | null;
  filename: string | null;
  source: 'youtube_import' | 'drive_import' | 'bucket_import';
  storage_provider: 'supabase' | 's3';
  error: string | null;
  created_at: string;
  updated_at: string;
}

export function queueYoutubeImport(scope: { recap_id?: string; event_id?: string }): Promise<QueuedImport> {
  return authedJson(`${BASE}/youtube`, { method: 'POST', body: JSON.stringify(scope) });
}

export function queueDriveImport(args: { folder_id: string; event_id?: string }): Promise<QueuedImport> {
  return authedJson(`${BASE}/drive`, { method: 'POST', body: JSON.stringify(args) });
}

export function queueBucketAdopt(args: { prefix?: string; event_id?: string }): Promise<QueuedImport & { prefix?: string }> {
  return authedJson(`${BASE}/bucket`, { method: 'POST', body: JSON.stringify(args) });
}

export async function listRecentImports(): Promise<ImportedAsset[]> {
  return (await authedJson<{ assets: ImportedAsset[] }>(`${BASE}/recent`)).assets;
}

export function formatBytes(n: number | null | undefined): string {
  const b = Number(n ?? 0);
  if (!b) return '—';
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(0)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
}
