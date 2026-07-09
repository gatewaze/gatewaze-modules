/**
 * Links tab — trackable short links (Umami Links via the redirects
 * provider) for this property's domains.
 *
 * Links are host-scoped: a slug lives at https://{domain}/go/{slug},
 * and every domain (the portal, each sites-module site) has its own
 * slug space. Creation/deletion go through the platform's
 * /api/redirects surface; click counts come from the per-link Umami
 * stats endpoint.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { authedFetch } from '../authed-fetch';
import { API, PANEL, MUTED, STRONG } from './shared';

interface RedirectRow {
  id: string;
  domain: string;
  path: string;
  short_url: string;
  original_url: string;
  title: string | null;
  created_at: string;
}

export default function LinksTab({ propertyId }: { propertyId: string }) {
  const [domains, setDomains] = useState<string[]>([]);
  const [links, setLinks] = useState<RedirectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const prop = await authedFetch(`${API()}/api/modules/analytics/properties/${propertyId}`).then((r) => r.json()) as
        { property: { domains: string[] } };
      const ds = (prop.property?.domains ?? []).filter((d) => d !== '*');
      setDomains(ds);
      const all: RedirectRow[] = [];
      for (const d of ds) {
        const r = await authedFetch(`${API()}/api/redirects?domain=${encodeURIComponent(d)}&provider=umami&limit=200`);
        if (r.ok) {
          const body = (await r.json()) as { redirects: RedirectRow[] };
          all.push(...(body.redirects ?? []));
        }
      }
      all.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      setLinks(all);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => { void load(); }, [load]);

  async function remove(id: string) {
    await authedFetch(`${API()}/api/redirects/link/${id}`, { method: 'DELETE' });
    setLinks((prev) => prev.filter((l) => l.id !== id));
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-[var(--red-6)] bg-[var(--red-2)] text-[var(--red-11)] px-4 py-3 text-sm">
          Failed to load links: {error}
        </div>
      )}

      <div className={PANEL}>
        <div className="flex items-baseline justify-between mb-3">
          <h3 className={`font-semibold ${STRONG}`}>Short links</h3>
          <span className={`text-xs ${MUTED}`}>{links.length} link{links.length === 1 ? '' : 's'}</span>
        </div>
        {loading ? (
          <p className={`text-sm ${MUTED} py-4`}>Loading links…</p>
        ) : links.length === 0 ? (
          <p className={`text-sm ${MUTED} py-4`}>
            No short links yet for {domains.join(', ') || 'this property'}. Create one below — it will live at{' '}
            <code>https://{domains[0] ?? '<domain>'}/go/&lt;slug&gt;</code>.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={`text-left text-xs uppercase tracking-wide ${MUTED} border-b border-[var(--gray-6)]`}>
                  <th className="py-2 pr-3 font-medium">Short link</th>
                  <th className="py-2 pr-3 font-medium">Destination</th>
                  <th className="py-2 pr-3 font-medium">Clicks (90d)</th>
                  <th className="py-2 pr-3 font-medium">Created</th>
                  <th className="py-2 pr-0" />
                </tr>
              </thead>
              <tbody>
                {links.map((l) => <LinkRow key={l.id} link={l} onDelete={() => remove(l.id)} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CreateLinkForm domains={domains} onCreated={load} />
    </div>
  );
}

function LinkRow({ link, onDelete }: { link: RedirectRow; onDelete: () => void }) {
  const [clicks, setClicks] = useState<{ clicks: number; unique_visitors: number } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authedFetch(`${API()}/api/redirects/link/${link.id}/stats`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => !cancelled && b && setClicks(b as { clicks: number; unique_visitors: number }))
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [link.id]);

  return (
    <tr className="border-b border-[var(--gray-4)]">
      <td className="py-2 pr-3">
        <button
          onClick={() => {
            void navigator.clipboard.writeText(link.short_url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className={`font-mono text-xs ${STRONG} hover:text-[var(--accent-11)]`}
          title="Copy short link"
        >
          {link.short_url.replace(/^https?:\/\//, '')} {copied ? '✓' : '⧉'}
        </button>
        {link.title && <div className={`text-xs ${MUTED}`}>{link.title}</div>}
      </td>
      <td className={`py-2 pr-3 font-mono text-xs max-w-md truncate ${MUTED}`} title={link.original_url}>
        {link.original_url}
      </td>
      <td className={`py-2 pr-3 tabular-nums ${STRONG}`}>
        {clicks ? <>{clicks.clicks}<span className={`text-xs ${MUTED}`}> ({clicks.unique_visitors} visitors)</span></> : '…'}
      </td>
      <td className={`py-2 pr-3 text-xs whitespace-nowrap ${MUTED}`}>{new Date(link.created_at).toLocaleDateString()}</td>
      <td className="py-2 pr-0 text-right">
        <button onClick={onDelete} className={`text-sm ${MUTED} hover:text-[var(--red-11)]`}>Delete</button>
      </td>
    </tr>
  );
}

function CreateLinkForm({ domains, onCreated }: { domains: string[]; onCreated: () => void }) {
  const [domain, setDomain] = useState('');
  const [slug, setSlug] = useState('');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!domain && domains.length) setDomain(domains[0]); }, [domains, domain]);

  const slugOk = /^[A-Za-z0-9._~-]{1,80}$/.test(slug);
  const urlOk = /^https?:\/\/.+/.test(url) && url.length <= 500;

  async function create() {
    setSaving(true);
    setError(null);
    try {
      const r = await authedFetch(`${API()}/api/redirects/create-bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'redirects-umami',
          domain,
          links: [{ path: slug, originalUrl: url, title: title.trim() || undefined }],
        }),
      });
      const body = (await r.json()) as { results?: Array<{ success: boolean; error?: string }> };
      if (!r.ok || !body.results?.[0]?.success) {
        throw new Error(body.results?.[0]?.error || `HTTP ${r.status}`);
      }
      setSlug(''); setUrl(''); setTitle('');
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const inputCls = 'px-3 py-1.5 rounded-md border border-[var(--gray-6)] bg-[var(--gray-1)] text-[var(--gray-12)] text-sm';

  return (
    <div className={PANEL}>
      <h3 className={`font-semibold mb-1 ${STRONG}`}>New short link</h3>
      <p className={`text-xs ${MUTED} mb-3`}>
        Each domain has its own slug space — sites added via the Sites module get their own links on their own domain.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {domains.length > 1 ? (
          <select value={domain} onChange={(e) => setDomain(e.target.value)} className={inputCls}>
            {domains.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        ) : (
          <span className={`text-sm font-mono ${MUTED}`}>{domain || '—'}</span>
        )}
        <span className={`text-sm ${MUTED}`}>/go/</span>
        <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="summer-launch" className={`${inputCls} font-mono w-44`} />
        <span className={`text-sm ${MUTED}`}>→</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://destination.example/page" className={`${inputCls} font-mono flex-1 min-w-64`} />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Label (optional)" className={`${inputCls} w-44`} />
        <Button onClick={create} disabled={saving || !domain || !slugOk || !urlOk}>
          {saving ? 'Creating…' : 'Create link'}
        </Button>
      </div>
      {slug && !slugOk && <p className={`text-xs ${MUTED} mt-2`}>Slugs: letters, numbers, dots, dashes, underscores (max 80).</p>}
      {error && <p className="text-sm text-[var(--red-11)] mt-2">{error}</p>}
    </div>
  );
}
