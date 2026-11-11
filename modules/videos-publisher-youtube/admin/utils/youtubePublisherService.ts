/**
 * Admin-side client for /api/modules/videos-publisher-youtube/*, which the
 * platform gates to super_admin. Named distinctively because every
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
      const body = (await res.json()) as { error?: string | { message?: string }; message?: string };
      detail = body.message || (typeof body.error === 'string' ? body.error : body.error?.message) || detail;
    } catch {
      // Non-JSON error page; the status is the best we have.
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

const BASE = '/api/modules/videos-publisher-youtube';

export interface YouTubeClientSettings {
  clientId: string;
  clientSecretSet: boolean;
  clientSecretReadable: boolean;
  redirectUri: string | null;
  scopes: string[];
}

export interface YouTubeConnection {
  id: string;
  external_account_id: string;
  label: string | null;
  state: string;
  state_detail: string | null;
  collection_enabled: boolean;
  last_collected_at: string | null;
  last_collect_status: string | null;
  created_at: string;
  /** Disconnected, but Google never confirmed the access was revoked. */
  needs_manual_revoke?: boolean;
}

export function getYouTubeSettings(): Promise<YouTubeClientSettings> {
  return authedJson(`${BASE}/settings`);
}

export function saveYouTubeSettings(patch: { clientId?: string; clientSecret?: string }): Promise<{ ok: true }> {
  return authedJson(`${BASE}/settings`, { method: 'PUT', body: JSON.stringify(patch) });
}

export async function listYouTubeConnections(): Promise<YouTubeConnection[]> {
  const r = await authedJson<{ connections: YouTubeConnection[] }>(`${BASE}/connections`);
  return r.connections ?? [];
}

/** Revoke and forget a channel's access. Its history is kept. */
export function disconnectYouTubeChannel(id: string): Promise<{ ok: true; revoked: boolean | null }> {
  return authedJson(`${BASE}/connections/${encodeURIComponent(id)}/disconnect`, { method: 'POST' });
}

/** A one-time Google consent URL, valid for ten minutes. */
export function startYouTubeConnect(): Promise<{ authorize_url: string; redirect_uri: string; expires_in_seconds: number }> {
  return authedJson(`${BASE}/oauth/start`);
}
