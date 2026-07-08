/**
 * Per-property settings page. Per spec §12.3.
 *
 * Surfaces:
 *   - General: name, domains
 *   - Embed snippet preview (read-only — operator copy/pastes)
 *   - Tracking scripts (head + body textareas)
 *   - Segment write key (write-only; UI shows configured ✓ / not configured)
 *
 * v0.1 scaffold — same minimal-styling approach as the other pages so
 * the route + data flow is exercised end-to-end. Full styled implementation
 * lands when wired into the admin design system.
 */
import { useEffect, useState } from 'react';
import { authedFetch } from './api';
import { useParams } from 'react-router';

interface Property {
  property_id: string;
  kind: string;
  name: string;
  domains: string[];
  status: string;
}

interface Scripts {
  script_head: string;
  script_body: string;
  updated_at: string | null;
}

export default function PropertySettingsPage() {
  const { id } = useParams<{ id: string }>();
  const [property, setProperty] = useState<Property | null>(null);
  const [scripts, setScripts] = useState<Scripts>({ script_head: '', script_body: '', updated_at: null });
  const [segmentConfigured, setSegmentConfigured] = useState<boolean | null>(null);
  const [segmentWriteKey, setSegmentWriteKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingScripts, setSavingScripts] = useState(false);

  useEffect(() => {
    if (!id) return;
    const apiUrl = import.meta.env.VITE_API_URL ?? '';
    Promise.all([
      authedFetch(`${apiUrl}/api/modules/analytics/properties/${id}`, { credentials: 'include' }).then((r) => r.json()),
      authedFetch(`${apiUrl}/api/modules/analytics/properties/${id}/scripts`, { credentials: 'include' }).then((r) => r.json()),
      authedFetch(`${apiUrl}/api/modules/analytics/properties/${id}/segment`, { credentials: 'include' }).then((r) => r.json()),
    ])
      .then(([prop, sc, seg]) => {
        setProperty((prop as { property: Property }).property);
        setScripts(sc as Scripts);
        setSegmentConfigured((seg as { configured: boolean }).configured);
      })
      .finally(() => setLoading(false));
  }, [id]);

  async function saveScripts() {
    if (!id) return;
    setSavingScripts(true);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      await authedFetch(`${apiUrl}/api/modules/analytics/properties/${id}/scripts`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script_head: scripts.script_head, script_body: scripts.script_body }),
      });
    } finally {
      setSavingScripts(false);
    }
  }

  async function saveSegment() {
    if (!id || !segmentWriteKey.trim()) return;
    const apiUrl = import.meta.env.VITE_API_URL ?? '';
    await authedFetch(`${apiUrl}/api/modules/analytics/properties/${id}/segment`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ write_key: segmentWriteKey.trim() }),
    });
    setSegmentWriteKey('');
    setSegmentConfigured(true);
  }

  if (loading || !property) return <div style={{ padding: '2rem' }}>Loading settings…</div>;

  return (
    <div style={{ padding: '2rem', maxWidth: '720px' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '1.5rem' }}>{property.name} — Settings</h1>

      <Section title="Embed snippet">
        <pre style={{ padding: '1rem', background: '#f5f5f5', borderRadius: '0.5rem', fontSize: '0.75rem', overflow: 'auto' }}>
{`<script async defer src="/a/${property.property_id}.js"></script>`}
        </pre>
        <p style={{ fontSize: '0.875rem', color: '#737373' }}>
          For external sites, paste this tag inside the `&lt;head&gt;` of every page you want to track.
        </p>
      </Section>

      <Section title="Tracking scripts">
        <p style={{ fontSize: '0.875rem', color: '#737373', marginBottom: '0.75rem' }}>
          Raw HTML/JS injected before <code>&lt;/head&gt;</code> and <code>&lt;/body&gt;</code> on every page using this property.
          Used for GTM, Hotjar, LinkedIn Insight, etc. Not sanitised — write access is restricted to admins.
        </p>
        <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.25rem' }}>Head</label>
        <textarea
          value={scripts.script_head}
          onChange={(e) => setScripts({ ...scripts, script_head: e.target.value })}
          rows={6}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.75rem', padding: '0.5rem', borderRadius: '0.25rem', border: '1px solid #d0d0d0' }}
        />
        <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginTop: '0.75rem', marginBottom: '0.25rem' }}>Body</label>
        <textarea
          value={scripts.script_body}
          onChange={(e) => setScripts({ ...scripts, script_body: e.target.value })}
          rows={6}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.75rem', padding: '0.5rem', borderRadius: '0.25rem', border: '1px solid #d0d0d0' }}
        />
        <button
          onClick={saveScripts}
          disabled={savingScripts}
          style={{ marginTop: '0.5rem', padding: '0.5rem 1rem', borderRadius: '0.25rem', background: '#0066cc', color: 'white', border: 'none', cursor: 'pointer' }}
        >
          {savingScripts ? 'Saving…' : 'Save scripts'}
        </button>
      </Section>

      <Section title="Segment integration">
        <p style={{ fontSize: '0.875rem', color: '#737373', marginBottom: '0.5rem' }}>
          Status: {segmentConfigured ? <strong style={{ color: '#0a7' }}>configured ✓</strong> : <span>not configured</span>}
        </p>
        <input
          type="password"
          value={segmentWriteKey}
          onChange={(e) => setSegmentWriteKey(e.target.value)}
          placeholder="Segment write key"
          style={{ width: '100%', padding: '0.5rem', fontFamily: 'monospace', fontSize: '0.875rem', borderRadius: '0.25rem', border: '1px solid #d0d0d0' }}
        />
        <button
          onClick={saveSegment}
          disabled={!segmentWriteKey.trim()}
          style={{ marginTop: '0.5rem', padding: '0.5rem 1rem', borderRadius: '0.25rem', background: '#0066cc', color: 'white', border: 'none', cursor: 'pointer' }}
        >
          Save Segment key
        </button>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ padding: '1.5rem 0', borderTop: '1px solid #f0f0f0' }}>
      <h2 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.75rem' }}>{title}</h2>
      {children}
    </section>
  );
}
