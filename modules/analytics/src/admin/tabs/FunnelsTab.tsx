/**
 * Funnels tab — ad-hoc conversion funnel builder (Umami v3 funnel
 * report). Define 2-8 steps (page paths or event names) + a conversion
 * window; results render as a step-down bar chart with drop-off rates.
 */
import { useState } from 'react';
import { Button } from '@/components/ui';
import { authedFetch } from '../authed-fetch';
import { API, rangeParams, PANEL, MUTED, STRONG, type RangeKey } from './shared';

interface StepDef { type: 'path' | 'event'; value: string }
interface StepResult extends StepDef {
  visitors: number;
  previous: number;
  dropped: number;
  dropoff: number | null;
  remaining: number;
}

export default function FunnelsTab({ propertyId, rangeKey }: { propertyId: string; rangeKey: RangeKey }) {
  const [steps, setSteps] = useState<StepDef[]>([
    { type: 'path', value: '/' },
    { type: 'path', value: '' },
  ]);
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [results, setResults] = useState<StepResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = steps.filter((s) => s.value.trim().length > 0);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const r = await authedFetch(
        `${API()}/api/modules/analytics/properties/${propertyId}/reports/funnel?${rangeParams(rangeKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ steps: valid, window: windowMinutes }),
        },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { steps: StepResult[] };
      setResults(body.steps ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  function setStep(i: number, patch: Partial<StepDef>) {
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  const inputCls = 'px-3 py-1.5 rounded-md border border-[var(--gray-6)] bg-[var(--gray-1)] text-[var(--gray-12)] text-sm';
  const firstVisitors = results?.[0]?.visitors ?? 0;

  return (
    <div className="space-y-4">
      <div className={PANEL}>
        <h3 className={`font-semibold mb-1 ${STRONG}`}>Funnel definition</h3>
        <p className={`text-xs ${MUTED} mb-3`}>
          Steps are page paths (e.g. <code>/events/upcoming</code>) or custom event names (e.g.{' '}
          <code>RSVP Submitted</code>). The window is how long a visitor has to complete each next step.
        </p>
        <div className="space-y-2">
          {steps.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className={`text-xs w-5 text-right tabular-nums ${MUTED}`}>{i + 1}.</span>
              <select
                value={s.type}
                onChange={(e) => setStep(i, { type: e.target.value as StepDef['type'] })}
                className={inputCls}
              >
                <option value="path">Page path</option>
                <option value="event">Event</option>
              </select>
              <input
                value={s.value}
                onChange={(e) => setStep(i, { value: e.target.value })}
                placeholder={s.type === 'path' ? '/some/page' : 'Event Name'}
                className={`${inputCls} flex-1 font-mono`}
              />
              {steps.length > 2 && (
                <button
                  onClick={() => setSteps((prev) => prev.filter((_, j) => j !== i))}
                  className={`text-sm ${MUTED} hover:text-[var(--red-11)] px-1`}
                  title="Remove step"
                >✕</button>
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 mt-3">
          {steps.length < 8 && (
            <button
              onClick={() => setSteps((prev) => [...prev, { type: 'path', value: '' }])}
              className={`text-sm ${MUTED} hover:text-[var(--gray-12)]`}
            >+ Add step</button>
          )}
          <span className={`text-sm ${MUTED} ml-auto`}>Window</span>
          <select value={windowMinutes} onChange={(e) => setWindowMinutes(Number(e.target.value))} className={inputCls}>
            <option value={15}>15 min</option>
            <option value={60}>1 hour</option>
            <option value={360}>6 hours</option>
            <option value={1440}>24 hours</option>
          </select>
          <Button onClick={run} disabled={running || valid.length < 2}>
            {running ? 'Running…' : 'Run funnel'}
          </Button>
        </div>
        {valid.length < 2 && <p className={`text-xs ${MUTED} mt-2`}>Fill in at least two steps.</p>}
      </div>

      {error && (
        <div className="rounded-lg border border-[var(--red-6)] bg-[var(--red-2)] text-[var(--red-11)] px-4 py-3 text-sm">
          Funnel failed: {error}
        </div>
      )}

      {results && (
        <div className={PANEL}>
          <h3 className={`font-semibold mb-4 ${STRONG}`}>Results</h3>
          {results.length === 0 ? (
            <p className={`text-sm ${MUTED}`}>No visitors matched the first step in this range.</p>
          ) : (
            <div className="space-y-3">
              {results.map((r, i) => {
                const width = firstVisitors > 0 ? (r.visitors / firstVisitors) * 100 : 0;
                return (
                  <div key={i}>
                    <div className="flex items-baseline justify-between text-sm mb-1">
                      <span className={STRONG}>
                        <span className={`${MUTED} tabular-nums mr-2`}>{i + 1}.</span>
                        <span className={r.type === 'path' ? 'font-mono text-xs' : ''}>{r.value}</span>
                        <span className={`ml-2 text-xs px-1.5 py-0.5 rounded bg-[var(--gray-4)] ${MUTED}`}>{r.type}</span>
                      </span>
                      <span className={`${STRONG} font-semibold tabular-nums`}>
                        {r.visitors.toLocaleString()} visitors
                        <span className={`ml-2 text-xs font-normal ${MUTED}`}>
                          {Math.round(r.remaining * 100)}% of start
                          {r.dropoff !== null && r.dropoff > 0 && (
                            <span className="text-[var(--red-11)]"> · −{Math.round(r.dropoff * 100)}% drop</span>
                          )}
                        </span>
                      </span>
                    </div>
                    <div className="h-6 rounded bg-[var(--gray-3)] overflow-hidden">
                      <div
                        className="h-full rounded bg-[var(--accent-9)] transition-all"
                        style={{ width: `${width}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
