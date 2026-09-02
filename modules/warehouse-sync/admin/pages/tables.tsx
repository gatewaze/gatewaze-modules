import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { ArrowPathIcon, CheckIcon } from '@heroicons/react/24/outline';
import { WarehouseSyncService, type TableSyncRow } from '../utils/warehouseSyncService';
import { Card, Badge, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
// One definition of the tab strip, shared with the dashboard: a duplicate here
// silently drifts the moment either page gains a tab.
import { wsTabs } from './health';
const tabPath = (id: string) => (id === 'tables' ? '/warehouse-sync/tables' : '/warehouse-sync');

/**
 * Tables tab — per-table sync configuration, edited here instead of the Airbyte
 * UI. Choose which tables sync, incremental vs full-refresh, a frequency tier,
 * log-based CDC, and PII posture. Multi-select rows to apply a setting to many
 * at once. On Save the module reconciles this into Airbyte connections (one per
 * active tier: Real-time ≈ every 5 min, Hourly, Daily).
 */
export default function WarehouseSyncTables() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<TableSyncRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const { tables, discoverError } = await WarehouseSyncService.getTables();
      setRows(tables);
      setSelected(new Set());
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

  /** Apply a patch to every currently-selected row (bulk edit). */
  const bulk = (patch: Partial<TableSyncRow>) =>
    setRows((rs) => rs.map((r) => (selected.has(r.table_name) ? { ...r, ...patch } : r)));

  const save = async () => {
    setSaving(true); setError(null); setNotice(null);
    try {
      const res = await WarehouseSyncService.saveTables(rows);
      const tiers = (res.tiers ?? []).map((t: any) => `${t.frequency}=${t.action}(${t.streams})`).join(', ');
      const skipped = (res as any).skipped as { table_name: string; reason: string }[] | undefined;
      const skipMsg = skipped && skipped.length
        ? ` — skipped ${skipped.length}: ${skipped.map((s) => s.table_name).join(', ')} (${skipped[0].reason})`
        : '';
      setNotice(res.reconciled ? `Saved. Airbyte updated: ${tiers}${skipMsg}` : `Saved (not reconciled: ${res.reason ?? 'Airbyte not configured'})`);
    } catch (e: any) {
      setError(e?.message ?? 'save failed');
    } finally {
      setSaving(false);
    }
  };

  const shown = useMemo(
    () => rows.filter((r) => r.table_name.toLowerCase().includes(filter.toLowerCase())),
    [rows, filter],
  );
  const enabledCount = rows.filter((r) => r.enabled).length;
  const allShownSelected = shown.length > 0 && shown.every((r) => selected.has(r.table_name));
  const someShownSelected = shown.some((r) => selected.has(r.table_name));

  const toggleSelectAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allShownSelected) shown.forEach((r) => next.delete(r.table_name));
      else shown.forEach((r) => next.add(r.table_name));
      return next;
    });
  const toggleOne = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  if (loading) {
    return <Page title="Warehouse Sync — Tables"><div className="p-6 animate-pulse"><div className="h-8 w-64 bg-neutral-200 rounded" /></div></Page>;
  }

  const selCount = selected.size;
  const bulkBtn = 'text-xs px-2 py-1 rounded border border-neutral-300 bg-white hover:bg-neutral-50 disabled:opacity-40';

  return (
    <Page title="Warehouse Sync — Tables">
      <WorkspaceLayout
        title="Warehouse Sync"
        subtitle="Tables to sync"
        tabs={wsTabs()}
        activeTabId="tables"
        onTabChange={(id) => navigate(tabPath(id))}
        actions={
          <div className="flex items-center gap-2">
            <button onClick={load} className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded bg-white/10 text-white hover:bg-white/20">
              <ArrowPathIcon className="h-4 w-4" /> Reload
            </button>
            <button onClick={save} disabled={saving} className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded bg-white text-neutral-900 disabled:opacity-50">
              <CheckIcon className="h-4 w-4" /> {saving ? 'Saving…' : 'Save & apply'}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge color="gray">{enabledCount} enabled / {rows.length}</Badge>
          {selCount > 0 && <Badge color="blue">{selCount} selected</Badge>}
        </div>

        {error && <Card className="p-3 border-error-300 bg-error-50 text-error-800 text-sm">{error}</Card>}
        {notice && <Card className="p-3 border-info-300 bg-info-50 text-info-800 text-sm">{notice}</Card>}

        <input
          value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter tables…"
          className="w-full max-w-sm text-sm px-3 py-1.5 rounded border border-neutral-300"
        />

        {/* Bulk-apply bar — acts on the selected rows */}
        {selCount > 0 && (
          <Card className="p-3 bg-neutral-50 border-neutral-200">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-medium text-neutral-700">Apply to {selCount} selected:</span>
              <div className="flex items-center gap-1">
                <button className={bulkBtn} onClick={() => bulk({ enabled: true })}>Enable</button>
                <button className={bulkBtn} onClick={() => bulk({ enabled: false })}>Disable</button>
              </div>
              <label className="flex items-center gap-1">Mode
                <select className="text-xs border border-neutral-300 rounded px-1 py-1"
                  onChange={(e) => e.target.value && bulk({ sync_mode: e.target.value as any })} defaultValue="">
                  <option value="" disabled>set…</option>
                  <option value="incremental">Incremental</option>
                  <option value="full_refresh">Full refresh</option>
                </select>
              </label>
              <label className="flex items-center gap-1">Frequency
                <select className="text-xs border border-neutral-300 rounded px-1 py-1"
                  onChange={(e) => e.target.value && bulk({ frequency: e.target.value as any })} defaultValue="">
                  <option value="" disabled>set…</option>
                  <option value="realtime">Real-time (~5 min)</option>
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                </select>
              </label>
              <div className="flex items-center gap-1">
                <span className="text-neutral-500">CDC</span>
                <button className={bulkBtn} onClick={() => bulk({ use_cdc: true })}>on</button>
                <button className={bulkBtn} onClick={() => bulk({ use_cdc: false })}>off</button>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-neutral-500">PII</span>
                <button className={bulkBtn} onClick={() => bulk({ include_pii: true })}>keep</button>
                <button className={bulkBtn} onClick={() => bulk({ include_pii: false })}>hide</button>
              </div>
            </div>
          </Card>
        )}

        <Card className="p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-500 bg-neutral-50">
                <tr>
                  <th className="px-3 py-2">
                    <input type="checkbox" aria-label="Select all"
                      checked={allShownSelected}
                      ref={(el) => { if (el) el.indeterminate = !allShownSelected && someShownSelected; }}
                      onChange={toggleSelectAll} />
                  </th>
                  <th className="px-4 py-2">Sync</th>
                  <th className="px-4 py-2">Table</th>
                  <th className="px-4 py-2">Mode</th>
                  <th className="px-4 py-2">Frequency</th>
                  <th className="px-4 py-2">Log-based CDC</th>
                  <th className="px-4 py-2">PII</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.table_name} className={`border-t ${r.enabled ? '' : 'opacity-60'} ${selected.has(r.table_name) ? 'bg-blue-50/40' : ''}`}>
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={selected.has(r.table_name)} onChange={() => toggleOne(r.table_name)} />
                    </td>
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
                    <td className="px-4 py-2">
                      <select value={r.include_pii ? 'keep' : 'hide'} disabled={!r.enabled}
                        onChange={(e) => update(r.table_name, { include_pii: e.target.value === 'keep' })}
                        className="text-sm border border-neutral-300 rounded px-2 py-1"
                        title="Keep = full row (production). Hide = redact PII columns (test).">
                        <option value="keep">Keep PII</option>
                        <option value="hide">Hide PII</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <p className="text-xs text-neutral-500">
          Tick rows to multi-select, then use the bar to apply a mode / frequency / CDC / PII setting to all at once.
          Frequency is applied per tier as its own Airbyte connection. <b>Log-based CDC</b> gives the most real-time
          sync + delete capture (needs the source publication / slot from migration 003). <b>Hide PII</b> replicates
          only non-PII columns — use it for test destinations; <b>Keep PII</b> replicates the full row for production.
          Save applies changes to Airbyte immediately.
        </p>
        </div>
      </WorkspaceLayout>
    </Page>
  );
}
