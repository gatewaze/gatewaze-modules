import { supabase } from '@/lib/supabase';

/**
 * Calls the module's own API (/api/modules/cvent/*) with the admin's session
 * token. Every route there checks the caller is an admin; the admin UI never
 * reads or writes the Cvent tables directly.
 */

function apiUrl(): string {
  return (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  const res = await fetch(`${apiUrl()}/api/modules/cvent${path}`, {
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
      // Non-JSON error body; keep the status text.
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export interface SyncStatus {
  active?: number;
  synced?: number;
  failed?: number;
  pending?: number;
  last_synced_at?: string | null;
  last_error?: string | null;
}

export interface SyncNowResult {
  attempted: number;
  created: number;
  alreadyExists: number;
  failed: number;
  remaining: boolean;
  aborted?: string;
  errors: string[];
  status?: SyncStatus;
}

/** Same ids the host passes to every event-detail slot: events.id (uuid). */
export function eventKey(eventId: string, eventUuid?: string): string {
  return eventUuid || eventId;
}
