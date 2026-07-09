/**
 * Top-level Analytics page — list of properties the user can read.
 * Per spec §12.1.
 *
 * v0.1: minimal scaffold. Full implementation (per-property cards with
 * 7d pageviews + active visitors) lands when the dashboards UI lib is
 * wired in. This placeholder confirms the route is mounted + rendered.
 */
import { useEffect, useState } from 'react';
import { authedFetch } from './authed-fetch';

interface Property {
  id: string;
  property_id: string;
  kind: string;
  name: string;
  status: string;
}

export default function PropertyListPage() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL ?? '';
    authedFetch(`${apiUrl}/api/modules/analytics/properties`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: { properties: Property[] }) => setProperties(body.properties ?? []))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding: '2rem' }}>Loading analytics properties…</div>;
  if (error) return <div style={{ padding: '2rem', color: '#b00' }}>Error: {error}</div>;

  return (
    <div style={{ padding: '2rem' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '1rem' }}>Analytics</h1>
      {properties.length === 0 ? (
        <p style={{ color: '#737373' }}>
          No properties yet. Properties for sites are auto-created when the site is created;
          register an external property via the API to track an off-platform site.
        </p>
      ) : (
        <ul style={{ display: 'grid', gap: '0.75rem', listStyle: 'none', padding: 0 }}>
          {properties.map((p) => (
            <li
              key={p.id}
              style={{
                padding: '1rem',
                border: '1px solid #e5e5e5',
                borderRadius: '0.5rem',
              }}
            >
              <a
                href={`/analytics/properties/${p.property_id}`}
                style={{ fontWeight: 600, color: '#0066cc', textDecoration: 'none' }}
              >
                {p.name}
              </a>
              <div style={{ fontSize: '0.875rem', color: '#737373', marginTop: '0.25rem' }}>
                <span>{p.kind}</span> · <span>{p.status}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
