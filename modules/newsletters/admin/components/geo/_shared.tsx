/** Shared presentational scaffolding for the geo-engagement reports. */

import type { ReactNode } from 'react';
import type { GeoEnvelope, GeoMeta } from './geo-types.js';
import { pct } from './geo-format.js';

export function Toggle<T extends string>({
  value, options, onChange, ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex rounded-md border border-gray-200 bg-gray-50 p-0.5 text-sm">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={
            'px-3 py-1 rounded ' +
            (value === o.value ? 'bg-white shadow-sm font-medium text-gray-900' : 'text-gray-500 hover:text-gray-700')
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Footer disclosing coverage + privacy suppression from a report's meta. */
export function MetaFooter({ meta }: { meta: GeoMeta | null | undefined }) {
  if (!meta) return null;
  const bits: string[] = [];
  bits.push(`${meta.total_events.toLocaleString()} events`);
  if (typeof meta.coverage_pct === 'number') bits.push(`${pct(meta.coverage_pct, 0)} geo coverage`);
  if (meta.suppressed_buckets > 0) bits.push(`${meta.suppressed_buckets} area${meta.suppressed_buckets === 1 ? '' : 's'} hidden for privacy`);
  if (meta.tz_fallback > 0) bits.push(`${meta.tz_fallback} with unknown timezone`);
  return <p className="mt-3 text-xs text-gray-400">{bits.join(' · ')}</p>;
}

/**
 * Wraps a report body with consistent loading / error / empty / schema-mismatch
 * states (spec §9, §11a). The map/chart is only rendered via `children` once we
 * have usable data; otherwise an explicit panel is shown — never a broken chart.
 */
export function ReportFrame({
  title, description, loading, error, schemaMismatch, env, children,
}: {
  title: string;
  description?: string;
  loading: boolean;
  error: string | null;
  schemaMismatch: boolean;
  env: GeoEnvelope<unknown> | null;
  children: ReactNode;
}) {
  const empty = !env || !env.meta || env.meta.total_events === 0 || env.data.length === 0;
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-3">
        <h3 className="text-base font-semibold text-gray-900">{title}</h3>
        {description && <p className="text-sm text-gray-500">{description}</p>}
      </div>
      {schemaMismatch ? (
        <Panel tone="warn">This report needs an update — the data format changed. Reload the admin app.</Panel>
      ) : error ? (
        <Panel tone="error">Couldn’t load this report. {error}</Panel>
      ) : loading ? (
        <Panel tone="muted">Loading…</Panel>
      ) : empty ? (
        <Panel tone="muted">Not enough engagement data yet to show this report.</Panel>
      ) : (
        children
      )}
      {!loading && !error && !schemaMismatch && env ? <MetaFooter meta={env.meta} /> : null}
    </section>
  );
}

function Panel({ tone, children }: { tone: 'muted' | 'warn' | 'error'; children: ReactNode }) {
  const cls = {
    muted: 'bg-gray-50 text-gray-500 border-gray-200',
    warn: 'bg-amber-50 text-amber-800 border-amber-200',
    error: 'bg-red-50 text-red-700 border-red-200',
  }[tone];
  return <div className={`rounded-md border px-4 py-8 text-center text-sm ${cls}`}>{children}</div>;
}
