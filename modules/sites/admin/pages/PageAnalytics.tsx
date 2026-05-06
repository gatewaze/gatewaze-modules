/**
 * Per-page analytics view — sits on the editor route as a tab next to
 * the editor itself. Fetches from the analytics module's site-scoped
 * convenience routes (`/api/modules/analytics/sites/:siteId/analytics/...`)
 * with `?pagePath=` to narrow to the current page.
 *
 * No chart lib — tables and big-number cards only. The fully-charted
 * dashboard lives elsewhere; this is the in-context view authors check
 * while editing.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Card } from '@/components/ui';
import { supabase } from '@/lib/supabase';

interface Summary {
  pageviews: number;
  unique_visitors: number;
  active_now: number;
  top_pages: { page_path: string; pageviews: number; unique_visitors: number }[];
}

interface PageviewBucket {
  bucket: string;
  pageviews: number;
  unique_visitors: number;
}

interface TopReferrer { referrer: string; pageviews: number }

interface SessionSummary {
  session_id: string;
  first_seen: string;
  last_seen: string;
  pageviews: number;
  events: number;
  country: string | null;
  browser: string | null;
  device: string | null;
  entry_path: string | null;
}

interface SessionPage {
  sessions: SessionSummary[];
  total: number;
  page: number;
  page_size: number;
}

const RANGE_OPTIONS = [
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
  { id: '90d', label: 'Last 90 days', ms: 90 * 24 * 60 * 60 * 1000 },
] as const;

type RangeId = (typeof RANGE_OPTIONS)[number]['id'];

interface Props {
  siteId: string;
  pagePath: string;
}

export function PageAnalytics({ siteId, pagePath }: Props) {
  const [rangeId, setRangeId] = useState<RangeId>('7d');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [series, setSeries] = useState<PageviewBucket[] | null>(null);
  const [referrers, setReferrers] = useState<TopReferrer[] | null>(null);
  const [sessions, setSessions] = useState<SessionPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const apiUrl = (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    const range = RANGE_OPTIONS.find((r) => r.id === rangeId)!;
    const to = new Date();
    const from = new Date(to.getTime() - range.ms);
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    const bucket = range.ms <= 24 * 60 * 60 * 1000 ? 'hour' : 'day';
    // pagePath filters every endpoint that accepts it; top-pages is
    // intentionally unfiltered server-side (it's cross-page by definition).
    const qsBase = `from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&pagePath=${encodeURIComponent(pagePath)}`;

    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const base = `${apiUrl}/api/modules/analytics/sites/${siteId}/analytics`;

    try {
      const [sumRes, seriesRes, refRes, sessRes] = await Promise.all([
        fetch(`${base}/summary?${qsBase}`, { headers }),
        fetch(`${base}/pageviews?${qsBase}&bucket=${bucket}`, { headers }),
        fetch(`${base}/referrers?${qsBase}&limit=10`, { headers }),
        fetch(`${base}/sessions?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&pageSize=10`, { headers }),
      ]);

      if (sumRes.status === 404) {
        setError('No analytics property is attached to this site yet.');
        setLoading(false);
        return;
      }
      if (!sumRes.ok) throw new Error(`summary: ${sumRes.status}`);

      const sumJson = await sumRes.json();
      const seriesJson = seriesRes.ok ? await seriesRes.json() : { pageviews: [] };
      const refJson = refRes.ok ? await refRes.json() : { referrers: [] };
      const sessJson = sessRes.ok ? await sessRes.json() : { sessions: [], total: 0, page: 1, page_size: 10 };

      setSummary(sumJson.summary as Summary);
      setSeries(seriesJson.pageviews as PageviewBucket[]);
      setReferrers(refJson.referrers as TopReferrer[]);
      setSessions(sessJson as SessionPage);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [apiUrl, siteId, pagePath, rangeId]);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  const openReplay = useCallback(async (sessionId: string) => {
    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(
      `${apiUrl}/api/modules/analytics/sites/${siteId}/analytics/sessions/${sessionId}/replay-link`,
      { headers },
    );
    if (!res.ok) return;
    const body = await res.json() as { url?: string };
    if (body.url) window.open(body.url, '_blank', 'noopener,noreferrer');
  }, [apiUrl, siteId]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm text-[var(--gray-a8)]">
          <span>Stats for </span>
          <span className="font-mono">{pagePath}</span>
        </div>
        <div className="flex items-center gap-2">
          {RANGE_OPTIONS.map((r) => (
            <Button
              key={r.id}
              variant={rangeId === r.id ? 'solid' : 'ghost'}
              size="1"
              onClick={() => setRangeId(r.id)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      {loading && <div className="text-sm text-[var(--gray-a8)]">Loading…</div>}
      {error && (
        <Card>
          <div className="p-4 text-sm text-[var(--orange-11)]">{error}</div>
        </Card>
      )}

      {!loading && !error && summary && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <BigStat label="Pageviews" value={summary.pageviews} />
            <BigStat label="Unique visitors" value={summary.unique_visitors} />
            <BigStat label="Active now" value={summary.active_now} />
          </div>

          <Card>
            <div className="p-4">
              <h3 className="text-sm font-semibold mb-3">Pageviews over time</h3>
              {series && series.length > 0 ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[var(--gray-a8)]">
                      <th className="font-medium pb-2">Bucket</th>
                      <th className="font-medium pb-2 text-right">Pageviews</th>
                      <th className="font-medium pb-2 text-right">Visitors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {series.map((b) => (
                      <tr key={b.bucket} className="border-t border-[var(--gray-a3)]">
                        <td className="py-1.5 font-mono text-xs">{b.bucket}</td>
                        <td className="py-1.5 text-right">{b.pageviews}</td>
                        <td className="py-1.5 text-right">{b.unique_visitors}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="text-sm text-[var(--gray-a8)]">No data in this range.</div>
              )}
            </div>
          </Card>

          <Card>
            <div className="p-4">
              <h3 className="text-sm font-semibold mb-3">Top referrers</h3>
              {referrers && referrers.length > 0 ? (
                <ul className="text-sm divide-y divide-[var(--gray-a3)]">
                  {referrers.map((r) => (
                    <li key={r.referrer || '(direct)'} className="py-1.5 flex justify-between">
                      <span className="truncate">{r.referrer || '(direct)'}</span>
                      <span className="text-[var(--gray-a8)]">{r.pageviews}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-sm text-[var(--gray-a8)]">No referrers in this range.</div>
              )}
            </div>
          </Card>

          <Card>
            <div className="p-4">
              <h3 className="text-sm font-semibold mb-3">Recent sessions ({sessions?.total ?? 0})</h3>
              {sessions && sessions.sessions.length > 0 ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[var(--gray-a8)]">
                      <th className="font-medium pb-2">Started</th>
                      <th className="font-medium pb-2">Entry</th>
                      <th className="font-medium pb-2">Country</th>
                      <th className="font-medium pb-2">Browser</th>
                      <th className="font-medium pb-2 text-right">Views</th>
                      <th className="pb-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.sessions.map((s) => (
                      <tr key={s.session_id} className="border-t border-[var(--gray-a3)]">
                        <td className="py-1.5 text-xs">{new Date(s.first_seen).toLocaleString()}</td>
                        <td className="py-1.5 font-mono text-xs truncate max-w-[16rem]">{s.entry_path ?? '—'}</td>
                        <td className="py-1.5 text-xs">{s.country ?? '—'}</td>
                        <td className="py-1.5 text-xs">{s.browser ?? '—'}</td>
                        <td className="py-1.5 text-right">{s.pageviews}</td>
                        <td className="py-1.5 text-right">
                          <Button variant="ghost" size="1" onClick={() => void openReplay(s.session_id)}>
                            Replay
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="text-sm text-[var(--gray-a8)]">No sessions in this range.</div>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function BigStat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <div className="p-4">
        <div className="text-xs text-[var(--gray-a8)] uppercase tracking-wide">{label}</div>
        <div className="mt-1 text-2xl font-semibold">{value.toLocaleString()}</div>
      </div>
    </Card>
  );
}
