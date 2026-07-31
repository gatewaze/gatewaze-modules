import React, { useState, useEffect } from 'react';
import {
  CircleStackIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  ArrowPathIcon,
  ClockIcon,
} from '@heroicons/react/24/outline';
import {
  WarehouseSyncService,
  formatBytes,
  formatDuration,
  type CdcHealth,
} from '../utils/warehouseSyncService';
import { Card, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';

/**
 * CDC Health dashboard (§12.4). Surfaces the slot-monitor's OPERATIONS tables:
 * replication-slot state (retained WAL / lag / active), open alerts (§10.4
 * thresholds), and the latest source-side reconciliation snapshot (§12.3).
 */
export default function WarehouseSyncHealth() {
  const [health, setHealth] = useState<CdcHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data, error } = await WarehouseSyncService.getHealth();
    setHealth(data);
    setError(error);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  const refresh = async () => {
    await WarehouseSyncService.sampleNow();
    setTimeout(load, 1500);
  };

  if (loading && !health) {
    return (
      <Page title="Warehouse Sync">
        <div className="p-6 animate-pulse space-y-4">
          <div className="h-8 bg-neutral-200 rounded w-64" />
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-28 bg-neutral-200 rounded" />
            ))}
          </div>
        </div>
      </Page>
    );
  }

  const crit = (health?.openAlerts ?? []).filter((a) => a.severity === 'critical').length;
  const warn = (health?.openAlerts ?? []).filter((a) => a.severity === 'warning').length;

  return (
    <Page title="Warehouse Sync">
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CircleStackIcon className="h-6 w-6 text-info-600" />
            <h1 className="text-xl font-semibold">Supabase → Snowflake replication</h1>
          </div>
          <button
            onClick={refresh}
            className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded border border-neutral-300 hover:bg-neutral-50"
          >
            <ArrowPathIcon className="h-4 w-4" /> Sample now
          </button>
        </div>

        {error && (
          <Card className="p-4 border-error-300 bg-error-50 text-error-800">
            Failed to load health: {error}. Have the migrations been applied and is the slot-monitor cron running?
          </Card>
        )}

        {/* Summary tiles */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <StatusTile
            label="Open alerts"
            value={crit > 0 ? `${crit} critical` : warn > 0 ? `${warn} warning` : 'Healthy'}
            tone={crit > 0 ? 'critical' : warn > 0 ? 'warning' : 'ok'}
          />
          <StatusTile
            label="Slots monitored"
            value={String(health?.slots.length ?? 0)}
            tone={(health?.slots.length ?? 0) > 0 ? 'ok' : 'warning'}
          />
          <StatusTile
            label="Max retained WAL"
            value={formatBytes(Math.max(0, ...(health?.slots ?? []).map((s) => s.retained_bytes)))}
            tone="neutral"
          />
          <StatusTile
            label="Max replication lag"
            value={formatDuration(Math.max(0, ...(health?.slots ?? []).map((s) => s.lag_seconds ?? 0)) || null)}
            tone="neutral"
          />
        </div>

        {/* Open alerts */}
        {(health?.openAlerts ?? []).length > 0 && (
          <Card className="p-0 overflow-hidden">
            <div className="px-4 py-3 border-b bg-neutral-50 font-medium flex items-center gap-2">
              <ExclamationTriangleIcon className="h-5 w-5 text-error-600" /> Open alerts (§10.4)
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-500">
                <tr>
                  <th className="px-4 py-2">Severity</th>
                  <th className="px-4 py-2">Slot</th>
                  <th className="px-4 py-2">Code</th>
                  <th className="px-4 py-2">Message</th>
                  <th className="px-4 py-2">Raised</th>
                </tr>
              </thead>
              <tbody>
                {health!.openAlerts.map((a) => (
                  <tr key={a.id} className="border-t">
                    <td className="px-4 py-2">
                      <Badge color={a.severity === 'critical' ? 'red' : 'amber'}>{a.severity}</Badge>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{a.slot_name}</td>
                    <td className="px-4 py-2 font-mono text-xs">{a.code}</td>
                    <td className="px-4 py-2">{a.message}</td>
                    <td className="px-4 py-2 text-neutral-500">{new Date(a.raised_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {/* Slots */}
        <Card className="p-0 overflow-hidden">
          <div className="px-4 py-3 border-b bg-neutral-50 font-medium">Replication slots</div>
          {(health?.slots ?? []).length === 0 ? (
            <div className="p-4 text-neutral-500 text-sm">
              No slot samples yet. The connector may not be provisioned, or the slot-monitor cron
              has not run. Slot name is set in module config (default <code>snowflake_cdc</code>).
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-500">
                <tr>
                  <th className="px-4 py-2">Slot</th>
                  <th className="px-4 py-2">Active</th>
                  <th className="px-4 py-2">Retained WAL</th>
                  <th className="px-4 py-2">Flush lag</th>
                  <th className="px-4 py-2">Replication lag</th>
                  <th className="px-4 py-2">Sampled</th>
                </tr>
              </thead>
              <tbody>
                {health!.slots.map((s) => (
                  <tr key={s.slot_name} className="border-t">
                    <td className="px-4 py-2 font-mono text-xs">{s.slot_name}</td>
                    <td className="px-4 py-2">
                      {s.active ? (
                        <span className="inline-flex items-center gap-1 text-success-700">
                          <CheckCircleIcon className="h-4 w-4" /> active
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-error-700">
                          <ExclamationTriangleIcon className="h-4 w-4" /> inactive{' '}
                          {formatDuration(s.inactive_seconds)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">{formatBytes(s.retained_bytes)}</td>
                    <td className="px-4 py-2">{formatBytes(s.flush_lag_bytes)}</td>
                    <td className="px-4 py-2">{formatDuration(s.lag_seconds)}</td>
                    <td className="px-4 py-2 text-neutral-500 flex items-center gap-1">
                      <ClockIcon className="h-3.5 w-3.5" />
                      {new Date(s.sampled_at).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* Airbyte connections & syncs (Option B control plane) */}
        <Card className="p-0 overflow-hidden">
          <div className="px-4 py-3 border-b bg-neutral-50 font-medium">Airbyte connections &amp; syncs</div>
          {(health?.airbyte ?? []).length === 0 ? (
            <div className="p-4 text-neutral-500 text-sm">
              No Airbyte connections observed. Configure <code>airbyteApiUrl</code> +{' '}
              <code>airbyteWorkspaceId</code> in module settings, then create the source/destination/connection
              in the central Airbyte for this brand&apos;s workspace.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-500">
                <tr>
                  <th className="px-4 py-2">Connection</th>
                  <th className="px-4 py-2">State</th>
                  <th className="px-4 py-2">Last sync</th>
                  <th className="px-4 py-2">Rows</th>
                  <th className="px-4 py-2">When</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {health!.airbyte.map((c) => (
                  <tr key={c.connection_id} className="border-t">
                    <td className="px-4 py-2">{c.name}</td>
                    <td className="px-4 py-2">
                      <Badge color={c.status === 'active' ? 'green' : 'gray'}>{c.status ?? '—'}</Badge>
                    </td>
                    <td className="px-4 py-2">
                      <Badge
                        color={
                          c.last_job_status === 'succeeded'
                            ? 'green'
                            : c.last_job_status === 'failed'
                              ? 'red'
                              : c.last_job_status === 'running'
                                ? 'blue'
                                : 'gray'
                        }
                      >
                        {c.last_job_status ?? '—'}
                      </Badge>
                    </td>
                    <td className="px-4 py-2">{c.rows_synced?.toLocaleString() ?? '—'}</td>
                    <td className="px-4 py-2 text-neutral-500">
                      {c.last_job_at ? new Date(c.last_job_at).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-2">
                      <button
                        onClick={async () => {
                          await WarehouseSyncService.triggerAirbyteSync(c.connection_id);
                          setTimeout(load, 2000);
                        }}
                        className="text-xs px-2 py-1 rounded border border-neutral-300 hover:bg-neutral-50"
                      >
                        Sync now
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* Reconciliation */}
        <Card className="p-0 overflow-hidden">
          <div className="px-4 py-3 border-b bg-neutral-50 font-medium">
            Source-side reconciliation snapshot (§12.3)
          </div>
          {(health?.reconcile ?? []).length === 0 ? (
            <div className="p-4 text-neutral-500 text-sm">
              No reconciliation snapshot yet (runs daily at 03:17 UTC).
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-500">
                <tr>
                  <th className="px-4 py-2">Table</th>
                  <th className="px-4 py-2">Live rows</th>
                  <th className="px-4 py-2">Deleted</th>
                  <th className="px-4 py-2">Freshest row</th>
                  <th className="px-4 py-2">Captured</th>
                </tr>
              </thead>
              <tbody>
                {health!.reconcile.map((r) => (
                  <tr key={r.table_name} className="border-t">
                    <td className="px-4 py-2 font-mono text-xs">{r.table_name}</td>
                    <td className="px-4 py-2">{r.live_rows.toLocaleString()}</td>
                    <td className="px-4 py-2">{r.deleted_rows.toLocaleString()}</td>
                    <td className="px-4 py-2 text-neutral-500">
                      {r.max_updated_at ? new Date(r.max_updated_at).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-2 text-neutral-500">{new Date(r.captured_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </Page>
  );
}

function StatusTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'ok' | 'warning' | 'critical' | 'neutral';
}) {
  const toneClass =
    tone === 'critical'
      ? 'text-error-700'
      : tone === 'warning'
        ? 'text-warning-700'
        : tone === 'ok'
          ? 'text-success-700'
          : 'text-neutral-900';
  return (
    <Card className="p-6">
      <div className="text-sm text-neutral-500 mb-1">{label}</div>
      <div className={`text-2xl font-semibold ${toneClass}`}>{value}</div>
    </Card>
  );
}
