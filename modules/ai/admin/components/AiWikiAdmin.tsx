/**
 * spec-ai-memory-wiki.md §5.5 — operator "Wiki" tab.
 *
 * Browse/search a use case's wiki, view+edit pages (raw markdown — the §5.7
 * CodeMirror live-preview editor is a follow-up), resolve sync conflicts, and
 * manage the git connection + cross-use-case grants.
 *
 * NOTE: written without a browser verification pass (no admin app running in
 * this environment). The data contracts match api/wiki.ts; behaviour should be
 * exercised in the admin before relying on it. Editor is intentionally a plain
 * textarea to stay dependency-light for v1.
 */

import { useEffect, useState } from 'react';
import { Button, IconButton } from '@/components/ui';
import { authedFetch } from '../utils/aiService';

interface UseCaseRef { id: string; label: string }
interface PageSummary { id: string; slug: string; title: string; summary: string | null; category: string | null; metadata: Record<string, unknown>; conflict?: boolean; updated_at: string }
interface WikiPage extends PageSummary { body: string; links: Array<{ to_use_case: string; to_slug: string }>; conflict_detail: Record<string, unknown> | null }
interface SyncState { use_case: string; git_remote: string | null; git_branch: string; pull_enabled: boolean; last_commit_sha: string | null; last_pulled_sha: string | null; synced_seq: number; pending_seq: number; conflict_count: number; last_error: string | null }
interface Grant { grantee_use_case: string; grantor_use_case: string; can_read: boolean; can_write: boolean }

const API = '/api/modules/ai/admin/wiki';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await authedFetch(`${API}${path}`, init);
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(j.error?.message ?? r.statusText);
  return j as T;
}

export default function AiWikiAdmin(): JSX.Element {
  const [useCases, setUseCases] = useState<UseCaseRef[]>([]);
  const [useCase, setUseCase] = useState('');
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [page, setPage] = useState<WikiPage | null>(null);
  const [inbound, setInbound] = useState<Array<{ from_use_case: string; from_slug: string }>>([]);
  const [editor, setEditor] = useState({ title: '', body: '', summary: '', category: '', metadata: '{}' });
  const [sync, setSync] = useState<SyncState | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [showSync, setShowSync] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await authedFetch('/api/modules/ai/admin/use-cases');
        const j = await r.json();
        const cases = (j.use_cases ?? j.useCases ?? []) as UseCaseRef[];
        setUseCases(cases);
        if (cases.length > 0) setUseCase(cases[0].id);
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    })();
  }, []);

  useEffect(() => { if (useCase) { void refreshPages(); void loadSync(); void loadGrants(); setPage(null); } }, [useCase]);

  async function refreshPages(): Promise<void> {
    setLoading(true); setError(null);
    try {
      if (query.trim()) {
        const j = await api<{ results: Array<{ slug: string; title: string; summary: string | null; snippet: string }> }>(`/search?use_case=${encodeURIComponent(useCase)}&q=${encodeURIComponent(query)}`);
        setPages(j.results.map((r) => ({ id: r.slug, slug: r.slug, title: r.title, summary: r.summary ?? r.snippet, category: null, metadata: {}, updated_at: '' })));
      } else {
        const j = await api<{ pages: PageSummary[] }>(`/pages?use_case=${encodeURIComponent(useCase)}&limit=500`);
        setPages(j.pages);
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setLoading(false); }
  }

  async function openPage(id: string): Promise<void> {
    setError(null);
    try {
      const j = await api<{ page: WikiPage; inbound: Array<{ from_use_case: string; from_slug: string }> }>(`/pages/${encodeURIComponent(id)}`);
      setPage(j.page); setInbound(j.inbound ?? []);
      setEditor({ title: j.page.title, body: j.page.body, summary: j.page.summary ?? '', category: j.page.category ?? '', metadata: JSON.stringify(j.page.metadata ?? {}, null, 2) });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function savePage(): Promise<void> {
    if (!page) return;
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(editor.metadata || '{}'); } catch { setError('metadata is not valid JSON'); return; }
    try {
      await api(`/pages/${encodeURIComponent(page.id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: editor.title, body: editor.body, summary: editor.summary || null, category: editor.category || null, metadata }) });
      await openPage(page.id); await refreshPages();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function createPage(): Promise<void> {
    const slug = prompt('New page slug (path, e.g. conferences/mumbai/notes):');
    if (!slug) return;
    try {
      const j = await api<{ page: WikiPage }>(`/pages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ use_case: useCase, slug, title: slug.split('/').pop(), body: '' }) });
      await refreshPages(); await openPage(j.page.id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function deletePage(): Promise<void> {
    if (!page || !confirm(`Delete "${page.slug}"? (soft delete; sync removes the file)`)) return;
    try { await api(`/pages/${encodeURIComponent(page.id)}`, { method: 'DELETE' }); setPage(null); await refreshPages(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function resolveConflict(choice: 'winner' | 'loser'): Promise<void> {
    if (!page) return;
    try { await api(`/pages/${encodeURIComponent(page.id)}/resolve-conflict`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice }) }); await openPage(page.id); await refreshPages(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function loadSync(): Promise<void> {
    try { const j = await api<{ state: SyncState }>(`/sync?use_case=${encodeURIComponent(useCase)}`); setSync(j.state); } catch { /* none yet */ }
  }
  async function saveSync(patch: Partial<SyncState>): Promise<void> {
    try { const j = await api<{ state: SyncState }>(`/sync`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ use_case: useCase, ...patch }) }); setSync(j.state); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  async function trigger(path: 'sync/run' | 'sync/pull'): Promise<void> {
    try { await api(`/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ use_case: useCase }) }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function loadGrants(): Promise<void> {
    try { const j = await api<{ grants: Grant[] }>(`/grants?use_case=${encodeURIComponent(useCase)}`); setGrants(j.grants); } catch { setGrants([]); }
  }
  async function addGrant(): Promise<void> {
    const grantor = prompt('Grant READ access to which use case (grantor)?');
    if (!grantor) return;
    try { await api(`/grants`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grantee_use_case: useCase, grantor_use_case: grantor, can_read: true }) }); await loadGrants(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  async function removeGrant(g: Grant): Promise<void> {
    try { await api(`/grants?grantee_use_case=${encodeURIComponent(g.grantee_use_case)}&grantor_use_case=${encodeURIComponent(g.grantor_use_case)}`, { method: 'DELETE' }); await loadGrants(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Wiki</h2>
        <p className="text-sm text-neutral-600">Durable, searchable, git-synced knowledge for this use case. Pages are markdown with <code>[[wiki links]]</code>; structured fields live in frontmatter (metadata).</p>
      </div>

      <div className="flex gap-3 items-end">
        <label className="space-y-1 text-sm">
          <div className="text-xs text-neutral-600">Use case</div>
          <select value={useCase} onChange={(e) => setUseCase(e.target.value)} className="border rounded px-2 py-1 font-mono">
            {useCases.map((u) => <option key={u.id} value={u.id}>{u.id}</option>)}
          </select>
        </label>
        <label className="flex-1 space-y-1 text-sm">
          <div className="text-xs text-neutral-600">Search</div>
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void refreshPages(); }} placeholder="hybrid search…" className="w-full border rounded px-2 py-1" />
        </label>
        <Button onClick={() => void refreshPages()} disabled={loading}>{query.trim() ? 'Search' : 'Refresh'}</Button>
        <Button onClick={() => void createPage()}>New page</Button>
        <Button onClick={() => setShowSync((v) => !v)}>{showSync ? 'Hide' : 'Sync & grants'}</Button>
      </div>

      {error && <div className="p-3 rounded border border-red-200 bg-red-50 text-red-700 text-sm">{error}</div>}

      {showSync && (
        <div className="p-3 rounded border border-neutral-200 bg-neutral-50 space-y-3 text-sm">
          <div className="font-medium">Git sync</div>
          <div className="flex gap-2 items-end flex-wrap">
            <label className="flex-1 space-y-1"><div className="text-xs text-neutral-600">Remote</div>
              <input defaultValue={sync?.git_remote ?? ''} onBlur={(e) => void saveSync({ git_remote: e.target.value || null })} placeholder="git@github.com:org/wiki.git" className="w-full border rounded px-2 py-1 font-mono" /></label>
            <label className="space-y-1"><div className="text-xs text-neutral-600">Branch</div>
              <input defaultValue={sync?.git_branch ?? 'main'} onBlur={(e) => void saveSync({ git_branch: e.target.value })} className="border rounded px-2 py-1 w-24" /></label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={sync?.pull_enabled ?? true} onChange={(e) => void saveSync({ pull_enabled: e.target.checked })} /> pull</label>
            <Button onClick={() => void trigger('sync/run')}>Push now</Button>
            <Button onClick={() => void trigger('sync/pull')}>Pull now</Button>
          </div>
          {sync && <div className="text-xs text-neutral-500">synced {sync.synced_seq}/{sync.pending_seq} · conflicts {sync.conflict_count} · commit {sync.last_commit_sha?.slice(0, 8) ?? '—'} {sync.last_error && <span className="text-red-600">· {sync.last_error}</span>}</div>}
          <div className="font-medium pt-2">Cross-wiki read grants</div>
          <div className="flex flex-wrap gap-2">
            {grants.map((g) => <span key={g.grantor_use_case} className="inline-flex items-center gap-1 border rounded px-2 py-0.5 text-xs">{g.grantor_use_case}<IconButton aria-label="Remove" onClick={() => void removeGrant(g)}>×</IconButton></span>)}
            <Button onClick={() => void addGrant()}>Add grant</Button>
          </div>
        </div>
      )}

      <div className="flex gap-4">
        <div className="w-1/3 space-y-1">
          {loading ? <div className="text-neutral-500 text-sm">Loading…</div>
            : pages.length === 0 ? <div className="text-sm text-neutral-500 p-3">No pages.</div>
            : pages.map((p) => (
              <button key={p.id} onClick={() => void openPage(p.id)} className={`block w-full text-left px-2 py-1 rounded text-sm hover:bg-neutral-100 ${page?.id === p.id ? 'bg-neutral-100' : ''}`}>
                <div className="font-mono text-xs text-neutral-500 break-all">{p.slug}{p.conflict && <span className="ml-1 text-amber-600">⚠ conflict</span>}</div>
                <div className="truncate">{p.title}</div>
              </button>
            ))}
        </div>

        <div className="flex-1">
          {!page ? <div className="text-sm text-neutral-500 p-6 border rounded border-neutral-200 bg-neutral-50">Select a page.</div> : (
            <div className="space-y-2">
              {page.conflict && (
                <div className="p-2 rounded border border-amber-300 bg-amber-50 text-sm flex items-center gap-2">
                  <span className="text-amber-800">Sync conflict — last-writer-wins applied; loser preserved.</span>
                  <Button onClick={() => void resolveConflict('winner')}>Keep current</Button>
                  <Button onClick={() => void resolveConflict('loser')}>Take other side</Button>
                </div>
              )}
              <input value={editor.title} onChange={(e) => setEditor({ ...editor, title: e.target.value })} className="w-full border rounded px-2 py-1 font-semibold" placeholder="Title" />
              <div className="flex gap-2">
                <input value={editor.summary} onChange={(e) => setEditor({ ...editor, summary: e.target.value })} className="flex-1 border rounded px-2 py-1 text-sm" placeholder="Summary" />
                <input value={editor.category} onChange={(e) => setEditor({ ...editor, category: e.target.value })} className="w-40 border rounded px-2 py-1 text-sm" placeholder="Category" />
              </div>
              <textarea value={editor.body} onChange={(e) => setEditor({ ...editor, body: e.target.value })} rows={16} className="w-full border rounded px-2 py-1 font-mono text-sm" placeholder="Markdown body — link with [[path/slug]]" />
              <details><summary className="text-xs text-neutral-600 cursor-pointer">metadata (frontmatter JSON)</summary>
                <textarea value={editor.metadata} onChange={(e) => setEditor({ ...editor, metadata: e.target.value })} rows={5} className="w-full border rounded px-2 py-1 font-mono text-xs" /></details>
              <div className="flex gap-2 items-center">
                <Button onClick={() => void savePage()}>Save</Button>
                <Button onClick={() => void deletePage()}>Delete</Button>
                {inbound.length > 0 && <span className="text-xs text-neutral-500">{inbound.length} inbound link{inbound.length === 1 ? '' : 's'}</span>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
