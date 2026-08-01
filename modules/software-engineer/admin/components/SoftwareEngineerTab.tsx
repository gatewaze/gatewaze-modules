// @ts-nocheck
/**
 * Software Engineer dashboard (spec §14 / §14.1). Standard admin dashboard shell: Page + hero
 * header + Tabs, matching the other dashboards (e.g. Emails). Tabs:
 *   - Overview — read-only KPI tiles + status/phase/project rollups (default landing).
 *   - Runs  — runs board + live "watch the agent" view (streamed events, chat/steer, override).
 *   - Issues — report/triage issues across projects.
 *   - Setup — per-brand credentials + repos (SetupPanel).
 * Admin design system (Tailwind + @/components/ui, Radix gray vars). No @radix-ui/themes import.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { Badge, Button, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import {
  CommandLineIcon, Cog6ToothIcon, ArrowPathIcon, ArrowUturnLeftIcon,
  XCircleIcon, PaperAirplaneIcon, ArrowTopRightOnSquareIcon, ArchiveBoxIcon, ClipboardDocumentListIcon,
  ChartBarIcon,
} from '@heroicons/react/24/outline';
import SetupPanel from './SetupPanel';
import { issueKey, mergeIssues, pendingOptimistic } from './issueList';
import OverviewView from './OverviewView';

const API = '/api/modules/software-engineer/admin';

async function api(path: string, init?: RequestInit) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const r = await fetch(`${API}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${r.status}`);
  return r.status === 204 ? null : r.json();
}

const STATUS_COLOR: Record<string, string> = {
  merged: 'green', pr_open: 'amber', watching: 'blue', changes_requested: 'amber',
  running: 'blue', failed: 'red', blocked: 'red', closed: 'gray', cancelled: 'gray', queued: 'gray',
};
const phaseColor = (s: string) =>
  s === 'passed' ? 'green' : s === 'failed' || s === 'blocked' ? 'red' : s === 'running' ? 'blue' : 'gray';

function RunsView({ selected, onSelect, onGoToSetup }: { selected: string | null; onSelect: (id: string | null) => void; onGoToSetup: () => void }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [detail, setDetail] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [chatAtts, setChatAtts] = useState<any[]>([]);   // pasted/dropped screenshots → uploaded to `media`
  const [err, setErr] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [projectList, setProjectList] = useState<any[]>([]);
  const [projectFilter, setProjectFilter] = useState('');   // '' = all projects
  const transcript = useRef<HTMLDivElement | null>(null);   // the transcript scroll container (bounded, scrolls internally)

  useEffect(() => { api('/projects').then((d) => setProjectList(d.projects ?? [])).catch(() => {}); }, []);

  const loadRuns = useCallback(async () => {
    try {
      const p = new URLSearchParams();
      if (showArchived) p.set('archived', '1');
      if (projectFilter) p.set('project', projectFilter);
      const qs = p.toString();
      setRuns((await api(`/runs${qs ? `?${qs}` : ''}`)).runs ?? []); setErr(null);
    } catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setLoading(false); }
  }, [showArchived, projectFilter]);
  const loadDetail = useCallback(async (id: string) => {
    try { setDetail(await api(`/runs/${id}`)); } catch (e: any) { setErr(String(e.message ?? e)); }
  }, []);

  useEffect(() => {
    loadRuns();
    const ch = supabase.channel('se-runs-board')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'se_runs' }, () => loadRuns())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [loadRuns]);

  useEffect(() => {
    setChatAtts([]);   // don't carry a pending upload from one run into another
    if (!selected) { setDetail(null); return; }
    loadDetail(selected);
    const reload = () => loadDetail(selected);
    const ch = supabase.channel(`se-run-${selected}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'se_events', filter: `run_id=eq.${selected}` }, reload)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'se_messages', filter: `run_id=eq.${selected}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'se_phases', filter: `run_id=eq.${selected}` }, reload)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'se_runs', filter: `id=eq.${selected}` }, reload)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [selected, loadDetail]);

  // Keep the transcript pinned to the newest message by scrolling ONLY the transcript container —
  // never the document (scrollIntoView would move every scrollable ancestor, incl. the page). Skip
  // when the user has scrolled up to read scrollback so live events don't yank them to the bottom.
  useEffect(() => {
    const el = transcript.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [detail?.messages?.length, detail?.events?.length]);

  // Paste/drop a screenshot into the live chat → upload to the public `media` bucket, then send its
  // URL with the message so the agent downloads + Reads it (same path as issue attachments).
  const uploadChatImage = async (file: File) => {
    if (!file.type.startsWith('image/')) return;
    if (file.size > 15 * 1024 * 1024) { setErr('image too large (max 15MB)'); return; }
    const key = crypto.randomUUID();
    const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
    const path = `se-runs/${selected || 'unknown'}/${key}.${ext}`;
    setChatAtts((a) => [...a, { key, name: file.name || `${key}.${ext}`, url: '', uploading: true }]);
    try {
      const { error } = await supabase.storage.from('media').upload(path, file, { upsert: false, cacheControl: '3600', contentType: file.type });
      if (error) throw error;
      const { data } = supabase.storage.from('media').getPublicUrl(path);
      setChatAtts((a) => a.map((x) => (x.key === key ? { ...x, uploading: false, url: data.publicUrl } : x)));
    } catch (e: any) { setErr(`image upload failed: ${String(e.message ?? e)}`); setChatAtts((a) => a.filter((x) => x.key !== key)); }
  };
  const onChatPaste = (e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData?.items ?? []).filter((it) => it.type.startsWith('image/'));
    if (!imgs.length) return;
    e.preventDefault();
    imgs.forEach((it) => { const f = it.getAsFile(); if (f) uploadChatImage(f); });
  };
  const onChatDrop = (e: React.DragEvent) => { e.preventDefault(); Array.from(e.dataTransfer?.files ?? []).forEach(uploadChatImage); };
  const onChatPick = (e: React.ChangeEvent<HTMLInputElement>) => { Array.from(e.target.files ?? []).forEach(uploadChatImage); e.target.value = ''; };
  const removeChatAtt = (key: string) => setChatAtts((a) => a.filter((x) => x.key !== key));
  const chatUploading = chatAtts.some((a) => a.uploading);

  const send = async () => {
    const content = draft;
    const images = chatAtts.filter((a) => a.url).map((a) => a.url);
    if (!selected || chatUploading || (!content.trim() && !images.length)) return;
    setDraft(''); setChatAtts([]);
    try { await api(`/runs/${selected}/message`, { method: 'POST', body: JSON.stringify({ content, images }) }); await loadDetail(selected); }
    catch (e: any) { setErr(String(e.message ?? e)); }
  };
  const override = async () => {
    if (!selected) return;
    const content = window.prompt('Override / redirect the agent (optional message):') ?? undefined;
    try { await api(`/runs/${selected}/interrupt`, { method: 'POST', body: JSON.stringify({ content }) }); } catch (e: any) { setErr(String(e.message ?? e)); }
  };
  const cancel = async () => {
    if (!selected || !window.confirm('Cancel this run?')) return;
    try { await api(`/runs/${selected}/cancel`, { method: 'POST' }); await loadRuns(); await loadDetail(selected); } catch (e: any) { setErr(String(e.message ?? e)); }
  };
  const archive = async (id: string, on: boolean) => {
    try { await api(`/runs/${id}/${on ? 'archive' : 'unarchive'}`, { method: 'POST' }); await loadRuns(); if (selected === id) await loadDetail(id); }
    catch (e: any) { setErr(String(e.message ?? e)); }
  };

  const liveStatus = ['queued', 'running', 'changes_requested'].includes(detail?.run?.status);

  return (
    <div className="flex gap-6 h-[calc(100dvh-var(--se-runs-chrome,240px))] overflow-hidden">
      {/* Runs board */}
      <div className="w-80 shrink-0 overflow-y-auto pr-1">
        {projectList.length > 1 && (
          <select
            value={projectFilter}
            onChange={(e) => { onSelect(null); setDetail(null); setProjectFilter(e.target.value); }}
            className="w-full mb-2 rounded-md border border-[var(--gray-6)] bg-transparent px-2 py-1.5 text-sm"
          >
            <option value="">All projects</option>
            {projectList.map((p) => <option key={p.id} value={p.id}>{p.avatar_emoji || '📁'} {p.name}</option>)}
          </select>
        )}
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--gray-10)]">{showArchived ? 'Archive' : 'Runs'}</div>
          <button onClick={() => { onSelect(null); setDetail(null); setShowArchived((v) => !v); }} className="text-[11px] text-[var(--gray-10)] hover:text-[var(--gray-12)] underline">
            {showArchived ? 'Show active' : 'Show archive'}
          </button>
        </div>
        {err && <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800 mb-2">{err}</div>}
        {loading ? (
          <div className="flex justify-center p-8"><LoadingSpinner /></div>
        ) : runs.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center space-y-3">
            <CommandLineIcon className="size-8 mx-auto text-[var(--gray-8)]" />
            <p className="font-medium text-[var(--gray-12)]">No runs yet</p>
            <p className="text-xs leading-relaxed text-[var(--gray-11)]">
              1. Add a brand’s GitHub + model credentials and a repo in <strong>Setup</strong>.<br />
              2. Label a GitHub issue <code className="font-mono text-[11px] bg-[var(--gray-3)] px-1 rounded">agent:build</code>.
            </p>
            <Button variant="solid" size="sm" onClick={onGoToSetup}><Cog6ToothIcon className="size-4 mr-1" />Go to Setup</Button>
          </div>
        ) : runs.map((r) => (
          <button
            key={r.id}
            onClick={() => onSelect(r.id)}
            className={`block w-full text-left rounded-md px-3 py-2 mb-1 border transition-colors ${
              selected === r.id ? 'border-[var(--gray-6)] bg-[var(--gray-3)]' : 'border-transparent hover:bg-[var(--gray-2)]'
            }`}
          >
            <div className="text-sm font-medium truncate text-[var(--gray-12)]">{r.repo_owner}/{r.repo_name} #{r.issue_number}</div>
            {r.title && <div className="text-xs text-[var(--gray-11)] truncate">{r.title}</div>}
            <div className="mt-1 flex items-center gap-2 flex-wrap">
              <Badge color={STATUS_COLOR[r.status] ?? 'gray'} size="1">{r.status}</Badge>
              <span className="text-xs text-[var(--gray-10)]">{r.current_phase}</span>
              {r.project?.name && <span className="text-[11px] text-[var(--gray-10)] ml-auto">{r.project.avatar_emoji || '📁'} {r.project.name}{r.engineer_name ? ` · ${r.engineer_name}` : ''}</span>}
            </div>
          </button>
        ))}
      </div>

      {/* Live agent view */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col border-l border-[var(--gray-5)] pl-6">
        {!detail ? (
          <div className="m-auto text-[var(--gray-10)] text-sm">Select a run to watch the agent.</div>
        ) : (
          <>
            <div className="pb-3 border-b border-[var(--gray-5)] mb-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-[var(--gray-12)]">{detail.run.repo_owner}/{detail.run.repo_name} #{detail.run.issue_number}</span>
                <Badge color={STATUS_COLOR[detail.run.status] ?? 'gray'}>{detail.run.status}</Badge>
                {detail.run.pr_state && detail.run.pr_state !== detail.run.status && (
                  <Badge color={STATUS_COLOR[detail.run.pr_state] ?? 'gray'} variant="soft" size="1">PR: {detail.run.pr_state}</Badge>
                )}
                {detail.run.project?.name && <span className="text-xs text-[var(--gray-10)]">{detail.run.project.avatar_emoji || '📁'} {detail.run.project.name}</span>}
                {detail.run.engineer_name && <span className="text-xs text-[var(--gray-10)]">🧑‍💻 {detail.run.engineer_name}</span>}
                {detail.run.revise_count > 0 && <span className="text-xs text-[var(--gray-10)]">· {detail.run.revise_count} revision{detail.run.revise_count > 1 ? 's' : ''}</span>}
                {detail.run.pr_url && (
                  <a href={detail.run.pr_url} target="_blank" rel="noreferrer" className="text-xs text-blue-500 inline-flex items-center gap-1">
                    PR <ArrowTopRightOnSquareIcon className="size-3" />
                  </a>
                )}
                <span className="ml-auto flex items-center gap-2">
                  <Button variant="soft" size="xs" onClick={override} disabled={!liveStatus}><ArrowUturnLeftIcon className="size-3.5 mr-1" />Override</Button>
                  <Button variant="soft" color="red" size="xs" onClick={cancel} disabled={!liveStatus}><XCircleIcon className="size-3.5 mr-1" />Cancel</Button>
                  {detail.run.archived_at
                    ? <Button variant="soft" size="xs" onClick={() => archive(detail.run.id, false)}>Unarchive</Button>
                    : <Button variant="soft" size="xs" onClick={() => archive(detail.run.id, true)}><ArchiveBoxIcon className="size-3.5 mr-1" />Archive</Button>}
                </span>
              </div>
              <div className="mt-2 flex gap-1.5 flex-wrap">
                {detail.phases.map((p: any) => (
                  <Badge key={p.id} color={phaseColor(p.status)} variant="soft" size="1">{p.phase}:{p.status}</Badge>
                ))}
              </div>
            </div>

            {/* Transcript */}
            <div ref={transcript} className="flex-1 min-h-0 overflow-y-auto pr-2 text-sm space-y-2">
              {(detail.messages ?? []).map((m: any) => (
                <div key={`m${m.id}`} className={`rounded-md px-3 py-2 border-l-2 bg-[var(--gray-2)] ${
                  m.role === 'admin' ? 'border-l-blue-400' : m.role === 'system' ? 'border-l-amber-400' : 'border-l-[var(--gray-6)]'
                }`}>
                  <div className="text-[11px] uppercase tracking-wide text-[var(--gray-10)]">{m.role}{m.sub_session_id ? ` · ${m.sub_session_id}` : ''}</div>
                  <div className="whitespace-pre-wrap text-[var(--gray-12)]">{m.content}</div>
                </div>
              ))}
              <details className="text-xs text-[var(--gray-11)]">
                <summary className="cursor-pointer select-none py-1">Tool activity ({(detail.events ?? []).length})</summary>
                <div className="space-y-0.5 mt-1">
                  {(detail.events ?? []).map((ev: any) => (
                    <div key={`e${ev.id}`} className="font-mono text-[11px] text-[var(--gray-10)]">
                      <span className="text-[var(--gray-9)]">{ev.kind}</span>{' '}
                      {ev.payload?.name ?? ev.payload?.summary ?? (ev.payload?.text ? String(ev.payload.text).slice(0, 140) : '')}
                    </div>
                  ))}
                </div>
              </details>
            </div>

            {/* Chat into the running agent */}
            <div className="mt-3 pt-3 border-t border-[var(--gray-5)]" onDrop={liveStatus ? onChatDrop : undefined} onDragOver={(e) => e.preventDefault()}>
              {chatAtts.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {chatAtts.map((a) => (
                    <div key={a.key} className="relative group">
                      {a.url
                        ? <img src={a.url} alt={a.name} className="h-14 w-14 rounded border object-cover" />
                        : <div className="h-14 w-14 rounded border flex items-center justify-center bg-[var(--gray-2)]"><LoadingSpinner /></div>}
                      <button type="button" onClick={() => removeChatAtt(a.key)} className="absolute -top-1.5 -right-1.5 rounded-full bg-[var(--gray-12)] text-[var(--gray-1)] size-4 leading-none text-[11px] opacity-0 group-hover:opacity-100" aria-label="Remove">×</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2 items-center">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
                  onPaste={liveStatus ? onChatPaste : undefined}
                  placeholder={liveStatus ? 'Message the agent…  (paste or drop a screenshot)' : 'Run is not live'}
                  disabled={!liveStatus}
                  className="flex-1 rounded-md border border-[var(--gray-6)] bg-transparent px-3 py-2 text-sm disabled:opacity-50"
                />
                <label className={`text-xs whitespace-nowrap ${liveStatus ? 'text-[var(--gray-10)] hover:text-[var(--gray-12)] cursor-pointer underline' : 'text-[var(--gray-8)] cursor-not-allowed'}`}>
                  Attach<input type="file" accept="image/*" multiple onChange={onChatPick} disabled={!liveStatus} className="hidden" />
                </label>
                <Button onClick={send} size="sm" disabled={!liveStatus || chatUploading || (!draft.trim() && !chatAtts.some((a) => a.url))}>
                  <PaperAirplaneIcon className="size-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function IssuesView() {
  const [issues, setIssues] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<any>({ project_id: '', title: '', body: '', assign: true });
  const [creating, setCreating] = useState(false);
  const [atts, setAtts] = useState<any[]>([]);   // pasted/dropped screenshots → uploaded to `media`
  // Optimistic rows for just-created issues. GitHub's list endpoint is eventually consistent, so the
  // POST-response issue often isn't in the next `/issues` fetch yet — we render it immediately and
  // reconcile (drop it once the real fetch surfaces it, keyed by project+number).
  const [optimistic, setOptimistic] = useState<any[]>([]);

  const load = useCallback(async () => {
    try { setIssues((await api(`/issues${filter ? `?project=${filter}` : ''}`)).issues ?? []); setErr(null); }
    catch (e: any) { setErr(String(e.message ?? e)); } finally { setLoading(false); }
  }, [filter]);
  useEffect(() => { api('/projects').then((d) => { setProjects(d.projects ?? []); setForm((f: any) => ({ ...f, project_id: f.project_id || d.projects?.[0]?.id || '' })); }).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);

  // Live run-status badges: se_runs is in Supabase, so realtime keeps them current (mirrors RunsView).
  useEffect(() => {
    const ch = supabase.channel('se-issues-runs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'se_runs' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  // The issue list itself lives on GitHub (no push to this client), so poll it — but only while the
  // tab is visible, and refetch immediately on re-focus so a hidden tab doesn't go stale.
  useEffect(() => {
    const tick = () => { if (typeof document === 'undefined' || !document.hidden) load(); };
    const id = setInterval(tick, 20000);
    const onVis = () => { if (typeof document !== 'undefined' && !document.hidden) load(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  // Drop optimistic rows once the real (GitHub-backed) fetch surfaces them.
  useEffect(() => {
    if (!optimistic.length) return;
    setOptimistic((o) => pendingOptimistic(o, issues));
  }, [issues]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconcile after a create: refetch a few times with backoff to absorb GitHub's propagation lag.
  const reconcile = useCallback(async () => {
    for (const delay of [800, 1500, 2500, 4000]) {
      await new Promise((r) => setTimeout(r, delay));
      await load();
    }
  }, [load]);

  // Upload one image to the public `media` bucket and track it; GitHub renders its public URL inline.
  const uploadImage = async (file: File) => {
    if (!file.type.startsWith('image/')) return;
    if (file.size > 15 * 1024 * 1024) { setErr('image too large (max 15MB)'); return; }
    const key = crypto.randomUUID();
    const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
    const path = `se-issues/${form.project_id || 'unknown'}/${key}.${ext}`;
    setAtts((a) => [...a, { key, name: file.name || `${key}.${ext}`, url: '', uploading: true }]);
    try {
      const { error } = await supabase.storage.from('media').upload(path, file, { upsert: false, cacheControl: '3600', contentType: file.type });
      if (error) throw error;
      const { data } = supabase.storage.from('media').getPublicUrl(path);
      setAtts((a) => a.map((x) => (x.key === key ? { ...x, uploading: false, url: data.publicUrl } : x)));
    } catch (e: any) { setErr(`image upload failed: ${String(e.message ?? e)}`); setAtts((a) => a.filter((x) => x.key !== key)); }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData?.items ?? []).filter((it) => it.type.startsWith('image/'));
    if (!imgs.length) return;
    e.preventDefault();
    imgs.forEach((it) => { const f = it.getAsFile(); if (f) uploadImage(f); });
  };
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); Array.from(e.dataTransfer?.files ?? []).forEach(uploadImage); };
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => { Array.from(e.target.files ?? []).forEach(uploadImage); e.target.value = ''; };
  const removeAtt = (key: string) => setAtts((a) => a.filter((x) => x.key !== key));

  const uploading = atts.some((a) => a.uploading);
  const create = async () => {
    if (!form.project_id || !form.title.trim() || uploading) return;
    setCreating(true);
    const title = form.title.trim();
    const projectId = form.project_id;
    const assign = form.assign;
    try {
      const res = await api('/issues', { method: 'POST', body: JSON.stringify({
        project_id: projectId, title, body: form.body, assign_to_agent: assign,
        attachments: atts.filter((a) => a.url).map((a) => ({ url: a.url })),
      }) });
      // Prepend an optimistic row from the server-returned identifiers (number/url/runId) so the new
      // issue shows instantly; hrefs come from the server, never from user input.
      if (res?.number) {
        const proj = projects.find((p) => p.id === projectId);
        setOptimistic((o) => [
          {
            project: { id: projectId, name: proj?.name, avatar_emoji: proj?.avatar_emoji },
            repo: '', number: res.number, title, url: res.url, labels: [], agent: assign,
            updated_at: new Date().toISOString(),
            run: res.runId ? { id: res.runId, status: 'queued' } : null,
            _optimistic: true,
          },
          ...o.filter((x) => !(x.number === res.number && x.project?.id === projectId)),
        ]);
      }
      setForm((f: any) => ({ ...f, title: '', body: '' })); setAtts([]);
      await load();
      reconcile();
    }
    catch (e: any) { setErr(String(e.message ?? e)); } finally { setCreating(false); }
  };

  // Render pending optimistic rows (not yet in the GitHub-backed list) above the real ones.
  const merged = mergeIssues(optimistic, issues);

  return (
    <div className="max-w-4xl space-y-4">
      {err && <div className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-800">{err}</div>}
      <section className="rounded-lg border p-4 space-y-2">
        <div className="font-medium">Report an issue</div>
        <div className="flex gap-2">
          <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })} className="rounded-md border px-2 py-1.5 text-sm">
            {projects.map((p) => <option key={p.id} value={p.id}>{p.avatar_emoji || '📁'} {p.name}</option>)}
          </select>
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Title" className="flex-1 rounded-md border px-3 py-1.5 text-sm" />
        </div>
        <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} onPaste={onPaste} onDrop={onDrop} onDragOver={(e) => e.preventDefault()} placeholder="Describe the problem or improvement…  (paste or drop a screenshot to attach)" rows={3} className="w-full rounded-md border px-3 py-2 text-sm" />
        {atts.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {atts.map((a) => (
              <div key={a.key} className="relative group">
                {a.url
                  ? <img src={a.url} alt={a.name} className="h-16 w-16 rounded border object-cover" />
                  : <div className="h-16 w-16 rounded border flex items-center justify-center bg-[var(--gray-2)]"><LoadingSpinner /></div>}
                <button type="button" onClick={() => removeAtt(a.key)} className="absolute -top-1.5 -right-1.5 rounded-full bg-[var(--gray-12)] text-[var(--gray-1)] size-4 leading-none text-[11px] opacity-0 group-hover:opacity-100" aria-label="Remove">×</button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={form.assign} onChange={(e) => setForm({ ...form, assign: e.target.checked })} className="size-4" />Hand to a software engineer agent</label>
            <label className="text-xs text-[var(--gray-10)] hover:text-[var(--gray-12)] cursor-pointer underline">
              Attach image<input type="file" accept="image/*" multiple onChange={onPick} className="hidden" />
            </label>
          </div>
          <Button size="sm" onClick={create} disabled={creating || uploading || !form.title.trim()}>{uploading ? 'Uploading…' : 'Create issue'}</Button>
        </div>
      </section>

      {projects.length > 1 && (
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded-md border px-2 py-1.5 text-sm">
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.avatar_emoji || '📁'} {p.name}</option>)}
        </select>
      )}
      {loading ? <div className="p-8 flex justify-center"><LoadingSpinner /></div>
        : merged.length === 0 ? <div className="text-sm text-[var(--gray-11)] p-6 text-center">No open issues.</div>
        : (
          <div className="space-y-1.5">
            {merged.map((i) => (
              <div key={issueKey(i)} className="flex items-center justify-between rounded-md border p-2.5 gap-2">
                <div className="min-w-0">
                  <a href={i.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-[var(--gray-12)] hover:underline block truncate">{i.title}</a>
                  <div className="text-[11px] text-[var(--gray-10)] truncate">{i.project?.avatar_emoji || '📁'} {i.project?.name} · {i.repo}#{i.number}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {i.run && <Badge color={STATUS_COLOR[i.run.status] ?? 'gray'} variant="soft" size="1">{i.run.status}{i.run.engineer_name ? ` · ${i.run.engineer_name}` : ''}</Badge>}
                  {i.agent && !i.run && <Badge color="blue" variant="soft" size="1">agent</Badge>}
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

const BASE = '/software-engineer';

export default function SoftwareEngineerTab() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // URL-driven so each tab + run have their own shareable URL:
  //   /software-engineer                → Overview (default landing)
  //   /software-engineer/runs           → Runs board
  //   /software-engineer/runs/<id>      → a specific run (deep-linkable)
  //   /software-engineer/issues         → Issues
  //   /software-engineer/setup          → Setup
  const m = pathname.match(/^\/software-engineer(?:\/(overview|setup|runs|issues)(?:\/([^/]+))?)?/);
  const section = m?.[1];
  const activeTab: 'overview' | 'runs' | 'issues' | 'setup' =
    section === 'runs' ? 'runs' : section === 'issues' ? 'issues' : section === 'setup' ? 'setup' : 'overview';
  const selectedRun = section === 'runs' ? (m?.[2] ?? null) : null;

  const onTabChange = (t: string) => navigate(t === 'overview' ? BASE : `${BASE}/${t}`);
  const onSelectRun = (id: string | null) => navigate(id ? `${BASE}/runs/${id}` : `${BASE}/runs`);

  return (
    <Page title="Software Engineer">
      <WorkspaceLayout
        title="Software Engineer"
        tabs={[
          { id: 'overview', label: 'Overview', icon: <ChartBarIcon className="size-4" /> },
          { id: 'runs', label: 'Runs', icon: <CommandLineIcon className="size-4" /> },
          { id: 'issues', label: 'Issues', icon: <ClipboardDocumentListIcon className="size-4" /> },
          { id: 'setup', label: 'Setup', icon: <Cog6ToothIcon className="size-4" /> },
        ]}
        activeTabId={activeTab}
        onTabChange={onTabChange}
      >
        <div className="py-6">
          {activeTab === 'overview' && <OverviewView onGoToSetup={() => onTabChange('setup')} />}
          {activeTab === 'runs' && <RunsView selected={selectedRun} onSelect={onSelectRun} onGoToSetup={() => onTabChange('setup')} />}
          {activeTab === 'issues' && <IssuesView />}
          {activeTab === 'setup' && <SetupPanel />}
        </div>
      </WorkspaceLayout>
    </Page>
  );
}
