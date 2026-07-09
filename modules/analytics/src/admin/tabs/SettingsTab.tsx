/**
 * Settings tab — property settings restyled onto the admin's Radix theme
 * (previously a standalone inline-styled page).
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { authedFetch } from '../authed-fetch';
import { API, PANEL, MUTED, STRONG } from './shared';

interface Property {
  property_id: string;
  kind: string;
  name: string;
  domains: string[];
  status: string;
}
interface Scripts { script_head: string; script_body: string; updated_at: string | null }

export default function SettingsTab({ propertyId }: { propertyId: string }) {
  const [property, setProperty] = useState<Property | null>(null);
  const [scripts, setScripts] = useState<Scripts>({ script_head: '', script_body: '', updated_at: null });
  const [segmentConfigured, setSegmentConfigured] = useState<boolean | null>(null);
  const [relaySegmentConfigured, setRelaySegmentConfigured] = useState<boolean | null>(null);
  const [segmentWriteKey, setSegmentWriteKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingScripts, setSavingScripts] = useState(false);
  const [savedTick, setSavedTick] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      authedFetch(`${API()}/api/modules/analytics/properties/${propertyId}`).then((r) => r.json()),
      authedFetch(`${API()}/api/modules/analytics/properties/${propertyId}/scripts`).then((r) => r.json()),
      authedFetch(`${API()}/api/modules/analytics/properties/${propertyId}/segment`).then((r) => r.json()),
      authedFetch(`${API()}/api/modules/analytics/relay-status`).then((r) => r.json()).catch(() => ({ segment_configured: null })),
    ])
      .then(([prop, sc, seg, relay]) => {
        setProperty((prop as { property: Property }).property);
        setScripts(sc as Scripts);
        setSegmentConfigured((seg as { configured: boolean }).configured);
        setRelaySegmentConfigured((relay as { segment_configured: boolean | null }).segment_configured);
      })
      .finally(() => setLoading(false));
  }, [propertyId]);

  async function saveScripts() {
    setSavingScripts(true);
    try {
      await authedFetch(`${API()}/api/modules/analytics/properties/${propertyId}/scripts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script_head: scripts.script_head, script_body: scripts.script_body }),
      });
      setSavedTick('scripts');
      setTimeout(() => setSavedTick(null), 2500);
    } finally {
      setSavingScripts(false);
    }
  }

  async function saveSegment() {
    if (!segmentWriteKey.trim()) return;
    await authedFetch(`${API()}/api/modules/analytics/properties/${propertyId}/segment`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ write_key: segmentWriteKey.trim() }),
    });
    setSegmentWriteKey('');
    setSegmentConfigured(true);
    setSavedTick('segment');
    setTimeout(() => setSavedTick(null), 2500);
  }

  if (loading || !property) return <p className={`text-sm ${MUTED} py-8`}>Loading settings…</p>;

  const inputCls = 'w-full px-3 py-2 rounded-md border border-[var(--gray-6)] bg-[var(--gray-1)] text-[var(--gray-12)] text-sm font-mono';

  return (
    <div className="space-y-4 max-w-3xl">
      <div className={PANEL}>
        <h3 className={`font-semibold mb-1 ${STRONG}`}>General</h3>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-sm mt-3">
          <dt className={MUTED}>Name</dt><dd className={STRONG}>{property.name}</dd>
          <dt className={MUTED}>Kind</dt><dd className={STRONG}>{property.kind}</dd>
          <dt className={MUTED}>Status</dt>
          <dd>
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
              property.status === 'active'
                ? 'bg-[var(--green-4)] text-[var(--green-11)]'
                : 'bg-[var(--amber-4)] text-[var(--amber-11)]'
            }`}>{property.status}</span>
          </dd>
          <dt className={MUTED}>Domains</dt>
          <dd className={`font-mono text-xs ${STRONG}`}>{property.domains.length ? property.domains.join(', ') : '—'}</dd>
        </dl>
      </div>

      <div className={PANEL}>
        <h3 className={`font-semibold mb-1 ${STRONG}`}>Embed snippet</h3>
        <p className={`text-sm ${MUTED} mb-2`}>
          For external sites, paste this tag inside the <code>&lt;head&gt;</code> of every page you want to track.
          The portal tracks itself automatically — no snippet needed there.
        </p>
        <pre className="px-3 py-2 rounded-md bg-[var(--gray-3)] text-[var(--gray-12)] text-xs overflow-x-auto">
{`<script async defer src="/a/${property.property_id}.js"></script>`}
        </pre>
      </div>

      <div className={PANEL}>
        <h3 className={`font-semibold mb-1 ${STRONG}`}>Tracking scripts</h3>
        <p className={`text-sm ${MUTED} mb-3`}>
          Raw HTML/JS injected before <code>&lt;/head&gt;</code> and <code>&lt;/body&gt;</code> on every page using
          this property. Used for GTM, Hotjar, LinkedIn Insight, etc. Not sanitised — write access is admin-only.
        </p>
        <label className={`block text-xs font-semibold mb-1 ${STRONG}`}>Head</label>
        <textarea
          value={scripts.script_head}
          onChange={(e) => setScripts({ ...scripts, script_head: e.target.value })}
          rows={5}
          className={inputCls}
        />
        <label className={`block text-xs font-semibold mt-3 mb-1 ${STRONG}`}>Body</label>
        <textarea
          value={scripts.script_body}
          onChange={(e) => setScripts({ ...scripts, script_body: e.target.value })}
          rows={5}
          className={inputCls}
        />
        <div className="flex items-center gap-3 mt-3">
          <Button onClick={saveScripts} disabled={savingScripts}>
            {savingScripts ? 'Saving…' : 'Save scripts'}
          </Button>
          {savedTick === 'scripts' && <span className="text-sm text-[var(--green-11)]">Saved ✓</span>}
        </div>
      </div>

      <div className={PANEL}>
        <h3 className={`font-semibold mb-1 ${STRONG}`}>Segment integration</h3>
        <div className="px-3 py-2.5 rounded-md bg-[var(--accent-3)] border border-[var(--accent-6)] text-sm text-[var(--gray-12)] mb-3">
          <strong>Portal &amp; server events:</strong> Segment forwarding for portal traffic is handled by the
          server-side tracking relay, configured platform-wide via the <code>SEGMENT_WRITE_KEY</code> deployment
          environment variable — not by this per-property field. Relay status:{' '}
          {relaySegmentConfigured === null
            ? <em>unknown</em>
            : relaySegmentConfigured
              ? <strong className="text-[var(--green-11)]">configured ✓</strong>
              : <strong className="text-[var(--red-11)]">not configured</strong>}
        </div>
        <p className={`text-sm ${MUTED} mb-2`}>
          The key below applies only to <strong>external-embed properties</strong> (sites that paste the{' '}
          <code>/a/&lt;id&gt;.js</code> pixel): it loads Segment&apos;s analytics.js in the embedding page.
          Per-property status:{' '}
          {segmentConfigured ? <strong className="text-[var(--green-11)]">configured ✓</strong> : <span>not configured</span>}
        </p>
        <input
          type="password"
          value={segmentWriteKey}
          onChange={(e) => setSegmentWriteKey(e.target.value)}
          placeholder="Segment write key"
          className={inputCls}
        />
        <div className="flex items-center gap-3 mt-3">
          <Button onClick={saveSegment} disabled={!segmentWriteKey.trim()}>Save Segment key</Button>
          {savedTick === 'segment' && <span className="text-sm text-[var(--green-11)]">Saved ✓</span>}
        </div>
      </div>
    </div>
  );
}
