/**
 * Funnels tab — saved conversion funnels + an ad-hoc builder.
 *
 * Definitions persist in analytics_saved_reports (results never do):
 * each saved funnel re-computes against Umami for the range picker's
 * window, so the same funnel tracks progress over time. The optional
 * trend view runs the funnel once per week (last 4 weeks) and charts
 * end-to-end conversion.
 */
import { useCallback, useEffect, useState } from 'react';
import ReactApexChart from 'react-apexcharts';
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
interface SavedFunnel {
  id: string;
  name: string;
  definition: { steps: StepDef[]; window?: number };
}
interface TrendPoint { label: string; conversion: number; started: number }

async function runFunnelReport(propertyId: string, steps: StepDef[], windowMinutes: number, from: string, to: string): Promise<StepResult[]> {
  const qs = new URLSearchParams({ from, to });
  const r = await authedFetch(
    `${API()}/api/modules/analytics/properties/${propertyId}/reports/funnel?${qs}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps, window: windowMinutes }),
    },
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return ((await r.json()) as { steps: StepResult[] }).steps ?? [];
}

export default function FunnelsTab({ propertyId, rangeKey }: { propertyId: string; rangeKey: RangeKey }) {
  const [saved, setSaved] = useState<SavedFunnel[]>([]);
  const [savedLoading, setSavedLoading] = useState(true);

  const loadSaved = useCallback(() => {
    setSavedLoading(true);
    authedFetch(`${API()}/api/modules/analytics/properties/${propertyId}/saved-reports?type=funnel`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b: { reports: SavedFunnel[] }) => setSaved(b.reports ?? []))
      .catch(() => setSaved([]))
      .finally(() => setSavedLoading(false));
  }, [propertyId]);

  useEffect(loadSaved, [loadSaved]);

  async function deleteSaved(id: string) {
    await authedFetch(`${API()}/api/modules/analytics/properties/${propertyId}/saved-reports/${id}`, { method: 'DELETE' });
    setSaved((prev) => prev.filter((f) => f.id !== id));
  }

  return (
    <div className="space-y-4">
      {savedLoading ? (
        <div className={PANEL}><p className={`text-sm ${MUTED} py-2`}>Loading saved funnels…</p></div>
      ) : (
        saved.map((f) => (
          <SavedFunnelCard key={f.id} propertyId={propertyId} funnel={f} rangeKey={rangeKey} onDelete={() => deleteSaved(f.id)} />
        ))
      )}
      <FunnelBuilder propertyId={propertyId} rangeKey={rangeKey} onSaved={loadSaved} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saved funnel card — auto-runs for the current range; optional trend.
// ---------------------------------------------------------------------------

function SavedFunnelCard({ propertyId, funnel, rangeKey, onDelete }: {
  propertyId: string;
  funnel: SavedFunnel;
  rangeKey: RangeKey;
  onDelete: () => void;
}) {
  const [results, setResults] = useState<StepResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trend, setTrend] = useState<TrendPoint[] | null>(null);
  const [trendLoading, setTrendLoading] = useState(false);
  const windowMinutes = funnel.definition.window ?? 60;

  useEffect(() => {
    let cancelled = false;
    setResults(null);
    setError(null);
    const qs = rangeParams(rangeKey);
    runFunnelReport(propertyId, funnel.definition.steps, windowMinutes, qs.get('from')!, qs.get('to')!)
      .then((r) => !cancelled && setResults(r))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [propertyId, funnel.id, rangeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadTrend() {
    setTrendLoading(true);
    try {
      const weeks: TrendPoint[] = [];
      for (let w = 3; w >= 0; w--) {
        const to = new Date(Date.now() - w * 7 * 864e5);
        const from = new Date(to.getTime() - 7 * 864e5);
        const steps = await runFunnelReport(propertyId, funnel.definition.steps, windowMinutes, from.toISOString(), to.toISOString());
        const started = steps[0]?.visitors ?? 0;
        const last = steps[steps.length - 1];
        weeks.push({
          label: `${from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}–${to.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
          conversion: started > 0 ? +(((last?.visitors ?? 0) / started) * 100).toFixed(1) : 0,
          started,
        });
      }
      setTrend(weeks);
    } finally {
      setTrendLoading(false);
    }
  }

  const started = results?.[0]?.visitors ?? 0;
  const finished = results?.[results.length - 1]?.visitors ?? 0;
  const conversion = started > 0 ? Math.round((finished / started) * 100) : null;

  return (
    <div className={PANEL}>
      <div className="flex items-center gap-3 mb-3">
        <h3 className={`font-semibold ${STRONG}`}>{funnel.name}</h3>
        <span className={`text-xs ${MUTED}`}>{funnel.definition.steps.length} steps · {windowMinutes >= 60 ? `${windowMinutes / 60}h` : `${windowMinutes}m`} window</span>
        {conversion !== null && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--accent-4)] text-[var(--accent-11)] font-semibold">
            {conversion}% conversion
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={trend ? () => setTrend(null) : loadTrend} disabled={trendLoading}
            className={`text-sm ${MUTED} hover:text-[var(--gray-12)]`}>
            {trendLoading ? 'Loading trend…' : trend ? 'Hide trend' : 'Trend'}
          </button>
          <button onClick={onDelete} className={`text-sm ${MUTED} hover:text-[var(--red-11)]`} title="Delete funnel">Delete</button>
        </div>
      </div>

      {error && <p className="text-sm text-[var(--red-11)]">Failed: {error}</p>}
      {!results && !error && <p className={`text-sm ${MUTED}`}>Running…</p>}
      {results && <FunnelBars results={results} />}

      {trend && (
        <div className="mt-4 border-t border-[var(--gray-5)] pt-3">
          <p className={`text-xs ${MUTED} mb-1`}>End-to-end conversion, weekly (last 4 weeks)</p>
          <ReactApexChart
            type="bar"
            height={160}
            options={{
              chart: { toolbar: { show: false }, fontFamily: 'inherit', background: 'transparent' },
              plotOptions: { bar: { columnWidth: '40%', borderRadius: 3 } },
              dataLabels: { enabled: true, formatter: (v: number) => `${v}%`, style: { colors: ['var(--gray-12)'] } },
              xaxis: { categories: trend.map((t) => t.label), labels: { style: { colors: 'var(--gray-10)' } } },
              yaxis: { max: 100, labels: { formatter: (v: number) => `${Math.round(v)}%`, style: { colors: 'var(--gray-10)' } } },
              grid: { strokeDashArray: 4, borderColor: 'var(--gray-5)' },
              colors: ['var(--accent-9)'],
              tooltip: { y: { formatter: (v: number, { dataPointIndex }: { dataPointIndex: number }) => `${v}% of ${trend[dataPointIndex]?.started ?? 0} started` } },
            }}
            series={[{ name: 'Conversion', data: trend.map((t) => t.conversion) }]}
          />
        </div>
      )}
    </div>
  );
}

function FunnelBars({ results }: { results: StepResult[] }) {
  const first = results[0]?.visitors ?? 0;
  if (results.length === 0) return <p className={`text-sm ${MUTED}`}>No visitors matched the first step in this range.</p>;
  return (
    <div className="space-y-3">
      {results.map((r, i) => (
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
            <div className="h-full rounded bg-[var(--accent-9)] transition-all" style={{ width: `${first > 0 ? (r.visitors / first) * 100 : 0}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Builder — run ad hoc, then save.
// ---------------------------------------------------------------------------

function FunnelBuilder({ propertyId, rangeKey, onSaved }: { propertyId: string; rangeKey: RangeKey; onSaved: () => void }) {
  const [steps, setSteps] = useState<StepDef[]>([
    { type: 'path', value: '/' },
    { type: 'path', value: '' },
  ]);
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [name, setName] = useState('');
  const [results, setResults] = useState<StepResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = steps.filter((s) => s.value.trim().length > 0);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const qs = rangeParams(rangeKey);
      setResults(await runFunnelReport(propertyId, valid, windowMinutes, qs.get('from')!, qs.get('to')!));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await authedFetch(`${API()}/api/modules/analytics/properties/${propertyId}/saved-reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'funnel', name: name.trim(), definition: { steps: valid, window: windowMinutes } }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setName('');
      setResults(null);
      setSteps([{ type: 'path', value: '/' }, { type: 'path', value: '' }]);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function setStep(i: number, patch: Partial<StepDef>) {
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  const inputCls = 'px-3 py-1.5 rounded-md border border-[var(--gray-6)] bg-[var(--gray-1)] text-[var(--gray-12)] text-sm';

  return (
    <div className={PANEL}>
      <h3 className={`font-semibold mb-1 ${STRONG}`}>New funnel</h3>
      <p className={`text-xs ${MUTED} mb-3`}>
        Steps are page paths (e.g. <code>/events/upcoming</code>) or custom event names (e.g.{' '}
        <code>RSVP Submitted</code>). Run it to preview, then save it to track conversion over time.
      </p>
      <div className="space-y-2">
        {steps.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className={`text-xs w-5 text-right tabular-nums ${MUTED}`}>{i + 1}.</span>
            <select value={s.type} onChange={(e) => setStep(i, { type: e.target.value as StepDef['type'] })} className={inputCls}>
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
              <button onClick={() => setSteps((prev) => prev.filter((_, j) => j !== i))}
                className={`text-sm ${MUTED} hover:text-[var(--red-11)] px-1`} title="Remove step">✕</button>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-3">
        {steps.length < 8 && (
          <button onClick={() => setSteps((prev) => [...prev, { type: 'path', value: '' }])}
            className={`text-sm ${MUTED} hover:text-[var(--gray-12)]`}>+ Add step</button>
        )}
        <span className={`text-sm ${MUTED} ml-auto`}>Window</span>
        <select value={windowMinutes} onChange={(e) => setWindowMinutes(Number(e.target.value))} className={inputCls}>
          <option value={15}>15 min</option>
          <option value={60}>1 hour</option>
          <option value={360}>6 hours</option>
          <option value={1440}>24 hours</option>
        </select>
        <Button onClick={run} disabled={running || valid.length < 2}>{running ? 'Running…' : 'Run funnel'}</Button>
      </div>

      {error && <p className="text-sm text-[var(--red-11)] mt-3">{error}</p>}

      {results && (
        <div className="mt-4 border-t border-[var(--gray-5)] pt-4">
          <FunnelBars results={results} />
          <div className="flex items-center gap-3 mt-4">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Funnel name (e.g. Event signup)"
              className={`${inputCls} flex-1 max-w-sm`}
            />
            <Button onClick={save} disabled={saving || !name.trim() || valid.length < 2}>
              {saving ? 'Saving…' : 'Save funnel'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
