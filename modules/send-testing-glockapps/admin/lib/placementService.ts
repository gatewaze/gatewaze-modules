import { supabase } from '@/lib/supabase';

const API_URL =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
const BASE = `${API_URL}/api/admin/modules/send-testing-glockapps`;

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as T & {
    error?: { code?: string; message?: string };
  };
  if (!res.ok) throw new Error(body?.error?.message || `Request failed (${res.status})`);
  return body as T;
}

function postJson<T>(path: string, payload?: unknown, method = 'POST'): Promise<T> {
  return json<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

export interface PlacementReport {
  id: string;
  run_id: string;
  provider: string;
  inbox: number;
  tabs: number;
  spam: number;
  missing: number;
  entered_via: 'api' | 'manual';
  glockapps_test_id: string | null;
  fetched_at: string;
}

export interface PlacementTest {
  id: string;
  run_id: string;
  glockapps_test_id: string;
  state: 'polling' | 'complete' | 'stopped' | 'failed';
  last_error: string | null;
  last_polled_at: string | null;
}

export interface GlockAppsStatus {
  mode: 'api' | 'manual';
  seed_list_mode: 'shared' | 'separate';
  list_id: string;
  seed_count: number;
}

export const PlacementService = {
  getStatus: () => json<GlockAppsStatus>('/status'),

  importSeeds: (emails?: string[]) =>
    postJson<{ imported: number }>('/seeds/import', emails ? { emails } : {}),

  removeSeeds: () => postJson<{ deleted: number }>('/seeds', undefined, 'DELETE'),

  getPlacement: (runId: string) =>
    json<{ mode: 'api' | 'manual'; reports: PlacementReport[]; test: PlacementTest | null }>(
      `/runs/${runId}/placement`,
    ),

  startTest: (runId: string, glockappsTestId?: string) =>
    postJson<PlacementTest>(
      `/runs/${runId}/placement/start`,
      glockappsTestId ? { glockapps_test_id: glockappsTestId } : {},
    ),

  saveManual: (
    runId: string,
    payload: { provider: string; inbox: number; tabs: number; spam: number; missing: number },
  ) => postJson<PlacementReport>(`/runs/${runId}/placement`, payload),
};

export default PlacementService;
