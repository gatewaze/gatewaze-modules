/**
 * UTM tab — campaign attribution breakdowns (source / medium / campaign /
 * term / content), via Umami's UTM report.
 */
import { useEffect, useState } from 'react';
import { getJson, rangeParams, PANEL, MUTED, STRONG, type RangeKey } from './shared';

interface Row { label: string; count: number }
interface UtmReport {
  utm_source: Row[];
  utm_medium: Row[];
  utm_campaign: Row[];
  utm_term: Row[];
  utm_content: Row[];
}

const PANELS: Array<{ key: keyof UtmReport; title: string }> = [
  { key: 'utm_source', title: 'Sources (utm_source)' },
  { key: 'utm_medium', title: 'Mediums (utm_medium)' },
  { key: 'utm_campaign', title: 'Campaigns (utm_campaign)' },
  { key: 'utm_content', title: 'Content (utm_content)' },
  { key: 'utm_term', title: 'Terms (utm_term)' },
];

export default function UtmTab({ propertyId, rangeKey }: { propertyId: string; rangeKey: RangeKey }) {
  const [report, setReport] = useState<UtmReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getJson<{ utm: UtmReport }>(`/api/modules/analytics/properties/${propertyId}/utm?${rangeParams(rangeKey)}`)
      .then((b) => !cancelled && setReport(b.utm))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [propertyId, rangeKey]);

  const empty = report && PANELS.every((p) => (report[p.key] ?? []).length === 0);

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-[var(--red-6)] bg-[var(--red-2)] text-[var(--red-11)] px-4 py-3 text-sm">
          Failed to load UTM report: {error}
        </div>
      )}
      {loading ? (
        <p className={`text-sm ${MUTED} py-8`}>Loading UTM report…</p>
      ) : empty ? (
        <div className={PANEL}>
          <p className={`text-sm ${MUTED} py-4`}>
            No UTM-tagged visits in this range. Traffic arriving with{' '}
            <code>?utm_source=…</code> parameters (newsletter links, campaigns, social posts) will appear here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {PANELS.map(({ key, title }) => {
            const rows = report?.[key] ?? [];
            const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
            return (
              <div key={key} className={PANEL}>
                <h3 className={`font-semibold mb-3 ${STRONG}`}>{title}</h3>
                {rows.length === 0 ? (
                  <p className={`text-sm ${MUTED} py-3`}>None in range</p>
                ) : (
                  <ul className="space-y-1">
                    {rows.map((r) => (
                      <li key={r.label} className="relative flex items-center justify-between text-sm py-1.5 px-2 rounded">
                        <span
                          className="absolute inset-y-0 left-0 rounded bg-[var(--accent-4)]"
                          style={{ width: `${max > 0 ? (r.count / max) * 100 : 0}%`, opacity: 0.5 }}
                        />
                        <span className={`relative truncate pr-3 ${STRONG}`}>{r.label}</span>
                        <span className={`relative font-semibold tabular-nums ${STRONG}`}>{r.count.toLocaleString()}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
