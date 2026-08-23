/**
 * Clarity signals strip for the Environments section.
 *
 * Deliberately its own file and its own fetch: the Environments panel is being
 * reworked in parallel, and this is additive — remove the one <ClaritySignals/>
 * line and nothing else changes.
 *
 * It shows the AGGREGATE behaviour signals Clarity's Data Export API returns
 * for the whole pr-view project — sessions plus the frustration metrics (rage
 * clicks, dead clicks, quick-backs, script errors) — with the age of the cache
 * and today's remaining call budget, and a link into Clarity for the actual
 * replays.
 *
 * Why aggregates and not per-env numbers by default: custom tags (we tag every
 * session with its env label) are a DASHBOARD filter, not an export-API
 * dimension. The only per-env handle the API offers is the URL dimension, and
 * only if its values carry hostnames. The server works that out and sends
 * `byEnv` when it can; when it cannot, this renders honest project-wide totals
 * rather than numbers that look per-env and are not.
 *
 * Renders nothing at all when the export feed is unconfigured.
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

type Budget = { day: string; calls: number; dailyCap: number; scheduledCap: number; remaining: number };
type ClarityPayload = {
  configured: boolean;
  projectId?: string;
  dashboardUrl?: string;
  fetchedAt?: string | null;
  lookbackDays?: number | null;
  ok?: boolean | null;
  error?: string | null;
  metrics?: { metricName: string; information: Record<string, unknown>[] }[];
  byEnv?: Record<string, Record<string, number>> | null;
  budget?: Budget;
};

/** Metric name → the short label the strip shows. Order is the display order. */
const SIGNALS: [string, string][] = [
  ['Traffic', 'sessions'],
  ['RageClickCount', 'rage clicks'],
  ['DeadClickCount', 'dead clicks'],
  ['QuickbackClick', 'quick backs'],
  ['ScriptErrorCount', 'JS errors'],
  ['ExcessiveScroll', 'excessive scroll'],
];

function sumMetric(metrics: ClarityPayload['metrics'], name: string): number | null {
  const m = metrics?.find((x) => x.metricName === name);
  if (!m || !m.information?.length) return null;
  let total = 0;
  for (const row of m.information) {
    const preferred = Number((row as Record<string, unknown>).totalSessionCount);
    if (Number.isFinite(preferred)) { total += preferred; continue; }
    for (const [k, v] of Object.entries(row)) {
      if (k === 'URL' || k === 'Url') continue;
      const n = Number(v);
      if (Number.isFinite(n)) { total += n; break; }
    }
  }
  return total;
}

function ago(iso?: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return 'unknown';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

// Same shape as every other standalone admin component's inline fetch helper
// (testEnv.ts's testEnvApi, ReportFeedbackWidget.tsx's api(), etc.): the explicit
// Bearer header is required, not decorative — the POST /refresh route rejects a
// cookie-only request specifically to close a CSRF-driven quota-exhaustion path
// (see admin-routes.ts's /test-env/clarity/refresh handler).
async function authHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function ClaritySignals({ apiBase = '/api/modules/software-engineer' }: { apiBase?: string }) {
  const [data, setData] = useState<ClarityPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/test-env/clarity`, { credentials: 'include', headers: await authHeaders() });
      if (!r.ok) return;
      setData(await r.json());
    } catch { /* the strip is decoration; never break the panel */ }
  }, [apiBase]);

  useEffect(() => { void load(); }, [load]);

  const refresh = useCallback(async () => {
    setBusy(true); setNote(null);
    try {
      const r = await fetch(`${apiBase}/test-env/clarity/refresh`, { method: 'POST', credentials: 'include', headers: await authHeaders() });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) setNote(body?.error?.message || 'Refresh failed');
      await load();
    } finally { setBusy(false); }
  }, [apiBase, load]);

  if (!data?.configured) return null;

  const metrics = data.metrics ?? [];
  const hasData = metrics.some((m) => m.information?.length);
  const budget = data.budget;

  return (
    <div className="rounded-md border border-[var(--gray-5)] px-3 py-2 text-[11px] text-[var(--gray-11)]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium text-[var(--gray-12)]">Session replay</span>
        {hasData ? (
          SIGNALS.map(([metric, label]) => {
            const v = sumMetric(metrics, metric);
            if (v === null) return null;
            return (
              <span key={metric}>
                <span className="font-mono text-[var(--gray-12)]">{v}</span> {label}
              </span>
            );
          })
        ) : (
          <span>
            {data.ok === false
              ? `last fetch failed (${data.error || 'unknown'})`
              : 'no sessions in Clarity’s window yet'}
          </span>
        )}
        <span className="ml-auto flex items-center gap-3">
          <span title={data.fetchedAt ? new Date(data.fetchedAt).toISOString() : undefined}>
            {data.lookbackDays ? `last ${data.lookbackDays}d, ` : ''}as of {ago(data.fetchedAt)}
          </span>
          {budget && (
            <span title={`Microsoft allows ${budget.dailyCap} Data Export calls per project per day; the automatic 3-hourly refresh uses at most ${budget.scheduledCap}. Resets 00:00 UTC.`}>
              {budget.remaining}/{budget.dailyCap} calls left today
            </span>
          )}
          <button
            type="button"
            onClick={refresh}
            disabled={busy || (budget ? budget.remaining === 0 : false)}
            className="text-blue-500 disabled:text-[var(--gray-8)]"
          >
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
          {data.dashboardUrl && (
            <a href={data.dashboardUrl} target="_blank" rel="noreferrer" className="text-blue-500">
              Recordings ↗
            </a>
          )}
        </span>
      </div>
      {note && <div className="mt-1 text-amber-600">{note}</div>}
      {data.byEnv
        ? (
          <div className="mt-1 flex flex-wrap gap-x-4">
            {Object.entries(data.byEnv).map(([label, counts]) => (
              <span key={label}>
                <span className="font-mono">{label}</span>: {counts.Traffic ?? 0} sessions
              </span>
            ))}
          </div>
        )
        : hasData && (
          <div className="mt-1 text-[var(--gray-10)]">
            Project-wide totals. Clarity&apos;s export API cannot group by our per-env tag &mdash;
            filter Recordings by the <span className="font-mono">env</span> custom tag for one environment.
          </div>
        )}
    </div>
  );
}
