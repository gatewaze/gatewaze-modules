/**
 * Journeys tab — the most common visitor paths (pageviews + events
 * interleaved), via Umami v3's journey report. Optional start/end
 * anchors narrow the paths.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { authedFetch } from '../authed-fetch';
import { API, rangeParams, PANEL, MUTED, STRONG, type RangeKey } from './shared';

interface JourneyPath { items: (string | null)[]; count: number }

export default function JourneysTab({ propertyId, rangeKey }: { propertyId: string; rangeKey: RangeKey }) {
  const [stepCount, setStepCount] = useState(3);
  const [startStep, setStartStep] = useState('');
  const [endStep, setEndStep] = useState('');
  const [paths, setPaths] = useState<JourneyPath[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authedFetch(
        `${API()}/api/modules/analytics/properties/${propertyId}/reports/journey?${rangeParams(rangeKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            steps: stepCount,
            ...(startStep.trim() ? { startStep: startStep.trim() } : {}),
            ...(endStep.trim() ? { endStep: endStep.trim() } : {}),
          }),
        },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { journeys: JourneyPath[] };
      setPaths((body.journeys ?? []).sort((a, b) => b.count - a.count));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [propertyId, rangeKey, stepCount, startStep, endStep]);

  // Auto-run on mount + range/steps change; anchors apply via the button.
  useEffect(() => { void run(); }, [propertyId, rangeKey, stepCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const inputCls = 'px-3 py-1.5 rounded-md border border-[var(--gray-6)] bg-[var(--gray-1)] text-[var(--gray-12)] text-sm';
  const maxCount = paths.reduce((m, p) => Math.max(m, p.count), 0);

  return (
    <div className="space-y-4">
      <div className={PANEL}>
        <div className="flex flex-wrap items-center gap-3">
          <span className={`text-sm ${MUTED}`}>Path length</span>
          <select value={stepCount} onChange={(e) => setStepCount(Number(e.target.value))} className={inputCls}>
            {[2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n} steps</option>)}
          </select>
          <input
            value={startStep}
            onChange={(e) => setStartStep(e.target.value)}
            placeholder="Starts at (path or event, optional)"
            className={`${inputCls} flex-1 min-w-40 font-mono`}
          />
          <input
            value={endStep}
            onChange={(e) => setEndStep(e.target.value)}
            placeholder="Ends at (optional)"
            className={`${inputCls} flex-1 min-w-40 font-mono`}
          />
          <Button onClick={run} disabled={loading}>{loading ? 'Loading…' : 'Apply'}</Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-[var(--red-6)] bg-[var(--red-2)] text-[var(--red-11)] px-4 py-3 text-sm">
          Failed to load journeys: {error}
        </div>
      )}

      <div className={PANEL}>
        <h3 className={`font-semibold mb-3 ${STRONG}`}>Common paths</h3>
        {loading ? (
          <p className={`text-sm ${MUTED} py-4`}>Loading…</p>
        ) : paths.length === 0 ? (
          <p className={`text-sm ${MUTED} py-4`}>No paths in this range.</p>
        ) : (
          <ul className="space-y-1.5">
            {paths.slice(0, 30).map((p, i) => (
              <li key={i} className="relative flex items-center gap-2 text-sm py-1.5 px-2 rounded">
                <span
                  className="absolute inset-y-0 left-0 rounded bg-[var(--accent-4)]"
                  style={{ width: `${maxCount > 0 ? (p.count / maxCount) * 100 : 0}%`, opacity: 0.4 }}
                />
                <span className={`relative font-semibold tabular-nums w-10 shrink-0 ${STRONG}`}>{p.count}×</span>
                <span className="relative flex items-center gap-1.5 flex-wrap">
                  {p.items.filter((it): it is string => it !== null).map((it, j, arr) => (
                    <span key={j} className="flex items-center gap-1.5">
                      <span className={`px-1.5 py-0.5 rounded text-xs ${
                        it.startsWith('/')
                          ? `bg-[var(--gray-4)] font-mono ${STRONG}`
                          : 'bg-[var(--accent-4)] text-[var(--accent-11)] font-medium'
                      }`}>{it}</span>
                      {j < arr.length - 1 && <span className={MUTED}>→</span>}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
