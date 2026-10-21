/**
 * Admin-side client for upload batches: /api/modules/videos/imports/batches.
 * Named per the rules in videosEditorService.ts.
 */

import { supabase } from '@/lib/supabase';

function apiUrl(): string {
  return (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  return fetch(`${apiUrl()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      detail = body.message || body.error || detail;
    } catch { /* non-JSON */ }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

const BASE = '/api/modules/videos/imports/batches';

export interface UploadBatch {
  id: string;
  label: string;
  event_id: string | null;
  prefix: string;
  state: 'open' | 'closed' | 'expired';
  issued_to_name: string | null;
  issued_to_email: string | null;
  key_expires_at: string | null;
  objects_seen: number;
  adopted: number;
  flags: Array<{ path: string; note: string; at: string }>;
  last_synced_at: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface BatchCredentials {
  cyberduck_url: string;
  s3_url: string;
  duck_bookmark: string;
  rclone_conf: string;
  rclone_command: string;
  fields: { endpoint: string; region: string; bucket: string; folder: string; key_id: string; key: string };
}

export interface BatchVideo {
  id: string;
  title: string;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  assets: Array<{ id: string; filename: string | null; bytes: number | null; state: string; created_at: string }>;
  subject: { subject_type: string; subject_id: string } | null;
  studio: { id: string; state: string; progress: string | null; error: string | null; thumbnail_url: string | null } | null;
}

export async function listBatches(): Promise<{ batches: UploadBatch[]; configured: boolean }> {
  return jsonOrThrow(await authedFetch(BASE));
}

export async function createBatch(input: { label: string; event_id?: string | null; issued_to_name?: string; issued_to_email?: string; days?: number }): Promise<{ batch: UploadBatch; credentials: BatchCredentials }> {
  return jsonOrThrow(await authedFetch(BASE, { method: 'POST', body: JSON.stringify(input) }));
}

export async function getBatch(id: string): Promise<{ batch: UploadBatch; videos: BatchVideo[] }> {
  return jsonOrThrow(await authedFetch(`${BASE}/${encodeURIComponent(id)}`));
}

export async function syncBatch(id: string): Promise<void> {
  await jsonOrThrow(await authedFetch(`${BASE}/${encodeURIComponent(id)}/sync`, { method: 'POST', body: '{}' }));
}

export async function closeBatch(id: string): Promise<{ batch: UploadBatch; key_revoked: boolean }> {
  return jsonOrThrow(await authedFetch(`${BASE}/${encodeURIComponent(id)}/close`, { method: 'POST', body: '{}' }));
}

export function formatBytes(bytes: number | null | undefined): string {
  const b = Number(bytes ?? 0);
  if (!Number.isFinite(b) || b <= 0) return '—';
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}
