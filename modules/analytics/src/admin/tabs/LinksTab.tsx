/**
 * Links tab — trackable short links (Umami Links via the redirects
 * provider) for this property's domains.
 *
 * Links are host-scoped: a slug lives at https://{domain}/go/{slug}
 * (or https://{domain}/{slug} on a SHORT_LINK_HOSTS domain), and every
 * domain has its own slug space. The list is paged and searched
 * server-side because a migrated domain can hold thousands of links. Creation/deletion go through the platform's
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

const PAGE_SIZE = 50;

/** Same charset as POST /api/redirects/create-bulk (Short.io-era links use & + ( ) [ ]). */
const SLUG_RE = /^[A-Za-z0-9._~&+()[\]-]{1,80}$/;

interface DomainInfo {
  total: number;
  /** Links on this host are served at /<slug> (SHORT_LINK_HOSTS) rather than /go/<slug>. */
  rootPath: boolean;
}

function redirectsUrl(domain: string, opts: { search?: string; limit: number; offset: number }): string {
  const q = new URLSearchParams({ domain, provider: 'umami', limit: String(opts.limit), offset: String(opts.offset) });
  if (opts.search) q.set('search', opts.search);
  return `${API()}/api/redirects?${q.toString()}`;
}

export default function LinksTab({ propertyId }: { propertyId: string }) {
  const [domains, setDomains] = useState<string[]>([]);
  const [domainInfo, setDomainInfo] = useState<Record<string, DomainInfo>>({});
  const [domain, setDomain] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [links, setLinks] = useState<RedirectRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Property domains, plus a count and serving shape per domain (one
  // 1-row request each), so the picker can show totals and the create
  // form the right path prefix.
  const loadDomains = useCallback(async () => {
    try {
      const prop = await authedFetch(`${API()}/api/modules/analytics/properties/${propertyId}`).then((r) => r.json()) as
        { property: { domains: string[] } };
      const ds = (prop.property?.domains ?? []).filter((d) => d !== '*');
      const info: Record<string, DomainInfo> = {};
      await Promise.all(ds.map(async (d) => {
        const r = await authedFetch(redirectsUrl(d, { limit: 1, offset: 0 }));
        const body = r.ok ? (await r.json()) as { redirects?: RedirectRow[]; total?: number } : {};
        const sample = body.redirects?.[0];
        info[d] = { total: body.total ?? 0, rootPath: !!sample && !sample.short_url.includes('/go/') };
      }));
      setDomains(ds);
      setDomainInfo(info);
      setDomain((cur) => (cur && ds.includes(cur) ? cur : ds.find((d) => (info[d]?.total ?? 0) > 0) ?? ds[0] ?? ''));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => { void loadDomains(); }, [loadDomains]);

  const loadPage = useCallback(async (offset: number) => {
    if (!domain) { setLinks([]); setTotal(0); setLoading(false); return; }
    if (offset === 0) setLoading(true); else setLoadingMore(true);
    setError(null);
    try {
      const r = await authedFetch(redirectsUrl(domain, { search, limit: PAGE_SIZE, offset }));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { redirects: RedirectRow[]; total?: number };
      setLinks((prev) => (offset === 0 ? body.redirects ?? [] : [...prev, ...(body.redirects ?? [])]));
      setTotal(body.total ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [domain, search]);

  useEffect(() => { void loadPage(0); }, [loadPage]);

  // Debounce the search box into the query.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  async function remove(id: string) {
    await authedFetch(`${API()}/api/redirects/link/${id}`, { method: 'DELETE' });
    setLinks((prev) => prev.filter((l) => l.id !== id));
    setTotal((t) => Math.max(0, t - 1));
  }

  const prefixFor = (d: string) => (domainInfo[d]?.rootPath ? '/' : '/go/');
  const inputCls = 'px-3 py-1.5 rounded-md border border-[var(--gray-6)] bg-[var(--gray-1)] text-[var(--gray-12)] text-sm';

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-[var(--red-6)] bg-[var(--red-2)] text-[var(--red-11)] px-4 py-3 text-sm">
          Failed to load links: {error}
        </div>
      )}

      <div className={PANEL}>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h3 className={`font-semibold ${STRONG}`}>Short links</h3>
          <div className="flex flex-wrap items-center gap-2">
            {domains.length > 1 && (
              <select value={domain} onChange={(e) => setDomain(e.target.value)} className={inputCls}>
                {domains.map((d) => (
                  <option key={d} value={d}>{d} ({(domainInfo[d]?.total ?? 0).toLocaleString()})</option>
                ))}
              </select>
            )}
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search slug, destination or label"
              className={`${inputCls} w-64`}
            />
            <span className={`text-xs ${MUTED}`}>
              {links.length.toLocaleString()} of {total.toLocaleString()} link{total === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        {loading ? (
          <p className={`text-sm ${MUTED} py-4`}>Loading links…</p>
        ) : links.length === 0 ? (
          <p className={`text-sm ${MUTED} py-4`}>
            {search
              ? <>No links match “{search}”.</>
              : <>No short links yet for {domain || 'this property'}. Create one below — it will live at{' '}
                <code>https://{domain || '<domain>'}{prefixFor(domain)}&lt;slug&gt;</code>.</>}
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
            {links.length < total && (
              <div className="pt-3 text-center">
                <Button onClick={() => void loadPage(links.length)} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : `Load ${Math.min(PAGE_SIZE, total - links.length)} more`}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <CreateLinkForm
        domains={domains}
        prefixFor={prefixFor}
        onCreated={() => { void loadDomains(); void loadPage(0); }}
      />
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

function CreateLinkForm({ domains, prefixFor, onCreated }: { domains: string[]; prefixFor: (d: string) => string; onCreated: () => void }) {
  const [domain, setDomain] = useState('');
  const [slug, setSlug] = useState('');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!domain && domains.length) setDomain(domains[0]); }, [domains, domain]);

  const slugOk = SLUG_RE.test(slug);
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
        <span className={`text-sm ${MUTED}`}>{prefixFor(domain)}</span>
        <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="summer-launch" className={`${inputCls} font-mono w-44`} />
        <span className={`text-sm ${MUTED}`}>→</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://destination.example/page" className={`${inputCls} font-mono flex-1 min-w-64`} />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Label (optional)" className={`${inputCls} w-44`} />
        <Button onClick={create} disabled={saving || !domain || !slugOk || !urlOk}>
          {saving ? 'Creating…' : 'Create link'}
        </Button>
      </div>
      {slug && !slugOk && <p className={`text-xs ${MUTED} mt-2`}>Slugs: letters, numbers and . _ ~ - & + ( ) [ ] (max 80).</p>}
      {error && <p className="text-sm text-[var(--red-11)] mt-2">{error}</p>}
    </div>
  );
}
