/**
 * Per-property dashboard page. Per spec §12.2.
 *
 * v0.1: minimal scaffold — pulls the headline summary from
 * /api/analytics/properties/:id/summary and renders pageview + visitor
 * counts. Top-pages, referrers, custom events all land in a follow-up
 * iteration; this confirms the data flow end-to-end.
 */
import { useEffect, useState } from 'react';
import { authedFetch } from './authed-fetch';
import { useParams } from 'react-router';

interface Summary {
  pageviews: number;
  unique_visitors: number;
  active_now: number;
  top_pages: Array<{ page_path: string; pageviews: number }>;
}

function isoNDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export default function PropertyDashboardPage() {
  const { id } = useParams<{ id: string }>();
  const [days, setDays] = useState<7 | 30 | 90>(7);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const apiUrl = import.meta.env.VITE_API_URL ?? '';
    const params = new URLSearchParams({ from: isoNDaysAgo(days), to: new Date().toISOString() });
    authedFetch(`${apiUrl}/api/modules/analytics/properties/${id}/summary?${params}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: { summary: Summary }) => setSummary(body.summary))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id, days]);

  if (!id) return <div style={{ padding: '2rem' }}>Missing property id</div>;

  return (
    <div style={{ padding: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Dashboard</h1>
        <select value={days} onChange={(e) => setDays(parseInt(e.target.value, 10) as 7 | 30 | 90)}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <a
          href={`/admin/analytics/properties/${id}/settings`}
          style={{ marginLeft: 'auto', color: '#0066cc' }}
        >
          Settings
        </a>
      </div>

      {loading && <div>Loading…</div>}
      {error && <div style={{ color: '#b00' }}>Error: {error}</div>}

      {summary && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '2rem' }}>
            <Card label="Pageviews" value={summary.pageviews} />
            <Card label="Unique visitors" value={summary.unique_visitors} />
            <Card label="Active now" value={summary.active_now} />
          </div>
          <h2 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.5rem' }}>Top pages</h2>
          {summary.top_pages.length === 0 ? (
            <p style={{ color: '#737373' }}>No pageviews yet in this range.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {summary.top_pages.map((p) => (
                <li key={p.page_path} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0', borderBottom: '1px solid #f0f0f0' }}>
                  <span style={{ fontFamily: 'monospace' }}>{p.page_path}</span>
                  <span>{p.pageviews}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ padding: '1rem', border: '1px solid #e5e5e5', borderRadius: '0.5rem' }}>
      <div style={{ fontSize: '0.75rem', color: '#737373', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: '1.875rem', fontWeight: 'bold', marginTop: '0.25rem' }}>{value.toLocaleString()}</div>
    </div>
  );
}
