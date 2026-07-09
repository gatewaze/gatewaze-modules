/**
 * Realtime tab — live active visitors + last-hour views/pages, polled
 * every 10s (the module's realtime endpoint caches 5s server-side).
 */
import { useEffect, useState } from 'react';
import { getJson, PANEL, MUTED, STRONG } from './shared';

interface Realtime {
  active_visitors: number;
  views_last_hour: number;
  top_pages: Array<{ page_path: string; pageviews: number }>;
}

export default function RealtimeTab({ propertyId }: { propertyId: string }) {
  const [rt, setRt] = useState<Realtime | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      getJson<{ realtime: Realtime }>(`/api/modules/analytics/properties/${propertyId}/realtime`)
        .then((b) => {
          if (cancelled) return;
          setRt(b.realtime);
          setUpdatedAt(new Date());
          setError(null);
        })
        .catch((e: Error) => !cancelled && setError(e.message));
    tick();
    const t = setInterval(tick, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [propertyId]);

  const max = (rt?.top_pages ?? []).reduce((m, p) => Math.max(m, p.pageviews), 0);

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-[var(--red-6)] bg-[var(--red-2)] text-[var(--red-11)] px-4 py-3 text-sm">
          Failed to load realtime: {error}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className={PANEL}>
          <div className={`text-xs uppercase tracking-wide ${MUTED} flex items-center gap-1.5`}>
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            Active visitors right now
          </div>
          <div className={`text-4xl font-bold mt-2 ${STRONG}`}>{rt?.active_visitors ?? '—'}</div>
        </div>
        <div className={PANEL}>
          <div className={`text-xs uppercase tracking-wide ${MUTED}`}>Views in the last hour</div>
          <div className={`text-4xl font-bold mt-2 ${STRONG}`}>{rt?.views_last_hour ?? '—'}</div>
        </div>
      </div>
      <div className={PANEL}>
        <div className="flex items-baseline justify-between mb-3">
          <h3 className={`font-semibold ${STRONG}`}>Active pages (last hour)</h3>
          {updatedAt && <span className={`text-xs ${MUTED}`}>updated {updatedAt.toLocaleTimeString()}</span>}
        </div>
        {(rt?.top_pages ?? []).length === 0 ? (
          <p className={`text-sm ${MUTED} py-4`}>No traffic in the last hour.</p>
        ) : (
          <ul className="space-y-1">
            {rt!.top_pages.map((p) => (
              <li key={p.page_path} className="relative flex items-center justify-between text-sm py-1.5 px-2 rounded">
                <span
                  className="absolute inset-y-0 left-0 rounded bg-[var(--accent-4)]"
                  style={{ width: `${max > 0 ? (p.pageviews / max) * 100 : 0}%`, opacity: 0.5 }}
                />
                <span className={`relative font-mono text-xs truncate pr-3 ${STRONG}`}>{p.page_path}</span>
                <span className={`relative font-semibold tabular-nums ${STRONG}`}>{p.pageviews}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
