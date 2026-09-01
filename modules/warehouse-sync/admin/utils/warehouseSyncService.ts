import { supabase } from '@/lib/supabase';

// ============================================================================
// Types — mirror the 001/004 operations tables + views.
// ============================================================================

export interface SlotHealthLatest {
  slot_name: string;
  sampled_at: string;
  active: boolean;
  retained_bytes: number;
  flush_lag_bytes: number;
  inactive_seconds: number | null;
  lag_seconds: number | null;
  alert_severity: 'warning' | 'critical' | null;
}

export interface OpenAlert {
  id: number;
  raised_at: string;
  slot_name: string | null;
  code: string;
  severity: 'warning' | 'critical';
  value: number | null;
  message: string;
  notified: boolean;
}

export interface ReconcileSnapshot {
  captured_at: string;
  table_name: string;
  live_rows: number;
  deleted_rows: number;
  max_updated_at: string | null;
}

export interface AirbyteConnection {
  connection_id: string;
  name: string;
  status: string | null;
  last_job_id: number | null;
  last_job_status: string | null;
  last_job_at: string | null;
  rows_synced: number | null;
  bytes_synced: number | null;
  last_error: string | null;
  observed_at: string;
}

export interface CdcHealth {
  slots: SlotHealthLatest[];
  openAlerts: OpenAlert[];
  reconcile: ReconcileSnapshot[];
  airbyte: AirbyteConnection[];
}

// ============================================================================
// Service
// ============================================================================

export const WarehouseSyncService = {
  async getHealth(): Promise<{ data: CdcHealth | null; error: string | null }> {
    try {
      const [slotsRes, alertsRes, airbyteRes] = await Promise.all([
        supabase.from('warehouse_sync_slot_health_latest').select('*'),
        supabase.from('warehouse_sync_open_alerts').select('*'),
        supabase.from('warehouse_sync_airbyte_connections').select('*').order('name'),
      ]);
      if (slotsRes.error) throw slotsRes.error;
      if (alertsRes.error) throw alertsRes.error;
      if (airbyteRes.error) throw airbyteRes.error;

      // Latest reconcile snapshot per table (client-side dedupe; small set).
      const recRes = await supabase
        .from('warehouse_sync_reconcile')
        .select('*')
        .order('captured_at', { ascending: false })
        .limit(200);
      if (recRes.error) throw recRes.error;
      const seen = new Set<string>();
      const reconcile: ReconcileSnapshot[] = [];
      for (const r of (recRes.data ?? []) as ReconcileSnapshot[]) {
        if (seen.has(r.table_name)) continue;
        seen.add(r.table_name);
        reconcile.push(r);
      }

      return {
        data: {
          slots: (slotsRes.data ?? []) as SlotHealthLatest[],
          openAlerts: (alertsRes.data ?? []) as OpenAlert[],
          reconcile,
          airbyte: (airbyteRes.data ?? []) as AirbyteConnection[],
        },
        error: null,
      };
    } catch (e: any) {
      return { data: null, error: e?.message ?? 'failed to load CDC health' };
    }
  },

  /** Ad-hoc slot sample (fires the monitor job now) — best-effort. */
  async sampleNow(): Promise<void> {
    // The monitor also runs on cron; this RPC lets an operator force a sample.
    await supabase.rpc('warehouse_sync_slot_health', { p_slot_name: null }).catch(() => {});
  },

  /**
   * Trigger a manual Airbyte sync via the module API route (server-side holds
   * the Airbyte token; the admin never sees it).
   */
  async triggerAirbyteSync(connectionId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await apiFetch(
        `/api/modules/warehouse-sync/airbyte/connections/${encodeURIComponent(connectionId)}/sync`,
        { method: 'POST' },
      );
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? 'request failed' };
    }
  },

  /** Source tables merged with their saved per-table sync config (Tables tab). */
  async getTables(): Promise<{ tables: TableSyncRow[]; discoverError: string | null; configured: boolean }> {
    const res = await apiFetch('/api/modules/warehouse-sync/tables');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  /** Save per-table config and reconcile into Airbyte connections. */
  async saveTables(tables: TableSyncRow[]): Promise<{ saved: boolean; reconciled: boolean; tiers?: unknown[]; reason?: string }> {
    const res = await apiFetch('/api/modules/warehouse-sync/tables', {
      method: 'PUT',
      body: JSON.stringify({ tables }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `HTTP ${res.status}`);
    }
    return res.json();
  },
};

export function formatBytes(n: number): string {
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export type SyncFrequency = 'realtime' | 'hourly' | 'daily';
export type SyncModeOpt = 'incremental' | 'full_refresh';

export interface TableSyncRow {
  table_name: string;
  enabled: boolean;
  sync_mode: SyncModeOpt;
  frequency: SyncFrequency;
  cursor_field: string | null;
  primary_key: string | null;
  use_cdc: boolean;
}

/**
 * Fetch a JWT-gated module API route. The module routes require a verified
 * session (requireJwt) and admin role — plain fetch carries no session across
 * the admin→api origin, so attach the Supabase access token, and target the
 * API host (VITE_API_URL), mirroring mcpAccessService.
 */
async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = (import.meta as any).env?.VITE_API_URL ?? '';
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${base}${path}`, { ...init, headers });
}
