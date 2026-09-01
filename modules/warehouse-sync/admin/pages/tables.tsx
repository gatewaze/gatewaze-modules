import React, { useState, useEffect } from 'react';
import { CircleStackIcon, ArrowPathIcon, CheckIcon } from '@heroicons/react/24/outline';
import { WarehouseSyncService, type TableSyncRow } from '../utils/warehouseSyncService';
import { Card, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';

/**
 * Tables tab — per-table sync configuration, edited here instead of the Airbyte
 * UI. Choose which tables sync, incremental vs full-refresh, and a frequency
 * tier. On Save the module reconciles this into Airbyte connections (one per
 * active tier: Real-time ≈ every 5 min, Hourly, Daily).
 */
export default function WarehouseSyncTables() {
  const [rows, setRows] = useState<TableSyncRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const { tables, discoverError } = await WarehouseSyncService.getTables();
      setRows(tables);
      if (discoverError) setNotice(discoverError);
    } catch (e: any) {
      setError(e?.message ?? 'failed to load tables');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const update = (name: string, patch: Partial<TableSyncRow>) =>
    setRows((rs) => rs.map((r) => (r.table_name === name ? { ...r, ...patch } : r)));

  const save = async () => {
    setSaving(true); setError(null); setNotice(null);
    try {
      const res = await WarehouseSyncService.saveTables(rows);
      setNotice(res.reconciled
        ? `Saved. Airbyte updated: ${(res.tiers ?? []).map((t: any) => `${t.frequency}=${t.action}(${t.streams})`).join(', ')}`
        : `Saved (not reconciled: ${res.reason ?? 'Airbyte not configured'})`);
    } catch (e: any) {
      setError(e?.message ?? 'save failed');
    } finally {
      setSaving(false);
    }
  };

  const shown = rows.filter((r) => r.table_name.toLowerCase().includes(filter.toLowerCase()));
  const enabledCount = rows.filter((r) => r.enabled).length;

  if (loading) {
    return <Page title="Warehouse Sync — Tables"><div className="p-6 animate-pulse"><div className="h-8 w-64 bg-neutral-200 rounded" /></div></Page>;
  }

  return (
    <Page title="Warehouse Sync — Tables">
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CircleStackIcon className="h-6 w-6 text-info-600" />
            <h1 className="text-xl font-semibold">Tables to sync</h1>
            <Badge color="gray">{enabledCount} enabled / {rows.length}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={load} className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded border border-neutral-300 hover:bg-neutral-50">
              <ArrowPathIcon className="h-4 w-4" /> Reload
            </button>
            <button onClick={save} disabled={saving} className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded bg-info-600 text-white disabled:opacity-50">
              <CheckIcon className="h-4 w-4" /> {saving ? 'Saving…' : 'Save & apply'}
            </button>
          </div>
        </div>

        {error && <Card className="p-3 border-error-300 bg-error-50 text-error-800 text-sm">{error}</Card>}
        {notice && <Card className="p-3 border-info-300 bg-info-50 text-info-800 text-sm">{notice}</Card>}

        <input
          value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter tables…"
          className="w-full max-w-sm text-sm px-3 py-1.5 rounded border border-neutral-300"
        />

        <Card className="p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-500 bg-neutral-50">
                <tr>
                  <th className="px-4 py-2">Sync</th>
                  <th className="px-4 py-2">Table</th>
                  <th className="px-4 py-2">Mode</th>
                  <th className="px-4 py-2">Frequency</th>
                  <th className="px-4 py-2">Log-based CDC</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.table_name} className={`border-t ${r.enabled ? '' : 'opacity-60'}`}>
                    <td className="px-4 py-2">
                      <input type="checkbox" checked={r.enabled} onChange={(e) => update(r.table_name, { enabled: e.target.checked })} />
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{r.table_name}</td>
                    <td className="px-4 py-2">
                      <select value={r.sync_mode} disabled={!r.enabled} onChange={(e) => update(r.table_name, { sync_mode: e.target.value as any })}
                        className="text-sm border border-neutral-300 rounded px-2 py-1">
                        <option value="incremental">Incremental</option>
                        <option value="full_refresh">Full refresh</option>
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <select value={r.frequency} disabled={!r.enabled} onChange={(e) => update(r.table_name, { frequency: e.target.value as any })}
                        className="text-sm border border-neutral-300 rounded px-2 py-1">
                        <option value="realtime">Real-time (~5 min)</option>
                        <option value="hourly">Hourly</option>
                        <option value="daily">Daily</option>
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <input type="checkbox" checked={r.use_cdc} disabled={!r.enabled || r.sync_mode !== 'incremental'}
                        onChange={(e) => update(r.table_name, { use_cdc: e.target.checked })} />
                      <span className="text-xs text-neutral-500 ml-1">captures deletes; needs the publication</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <p className="text-xs text-neutral-500">
          Frequency is applied per tier as its own Airbyte connection (Airbyte schedules are per-connection).
          Incremental = change-based; enable <b>Log-based CDC</b> for the most real-time + delete capture (requires the
          source publication / replication slot from migration 003). Save applies changes to Airbyte immediately.
        </p>
      </div>
    </Page>
  );
}
