// @ts-nocheck
/**
 * "Report feedback" — the §10.5 in-page entry point. A floating button on EVERY admin page
 * (self-mounted at admin boot via admin/index.ts — no platform change needed) opening a compact
 * triage panel seeded with the CURRENT route, so feedback arrives anchored to where it happened.
 *
 * Renders nothing unless the signed-in user passes the SE admin gate (the /projects probe 401/403s
 * for everyone else). The copilot drafts; the human reviews the editable draft and creates via the
 * same POST /issues primitive as the Issues tab (project PAT, human-confirmed — the model can't
 * create anything itself).
 */
import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import TriageCopilot from './TriageCopilot';

const API = '/api/modules/software-engineer/admin';

async function api(path: string, init?: RequestInit) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const r = await fetch(`${API}${path}`, {
    ...init, credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${r.status}`);
  return r.status === 204 ? null : r.json();
}

export default function ReportFeedbackWidget() {
  const [projects, setProjects] = useState<any[] | null>(null); // null = probe not passed → render nothing
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [draft, setDraft] = useState<any | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api('/projects')
      .then((d) => { const l = d?.projects ?? []; if (l.length) { setProjects(l); setProjectId(l[0].id); } })
      .catch(() => { /* not an SE admin → widget stays hidden */ });
  }, []);

  if (!projects) return null;

  const create = async () => {
    if (!draft?.title?.trim() || creating) return;
    setCreating(true); setErr(null);
    try {
      const res = await api('/issues', { method: 'POST', body: JSON.stringify({
        project_id: projectId, title: draft.title.trim(), body: draft.body ?? '', assign_to_agent: !!draft.assign,
      }) });
      setCreated(res); setDraft(null);
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setCreating(false); }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {open && (
        <div className="w-[380px] max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--gray-6)] bg-[var(--gray-1)] p-3 shadow-xl space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            Report feedback
            {projects.length > 1 && (
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="ml-auto rounded-md border px-1.5 py-0.5 text-xs">
                {projects.map((p) => <option key={p.id} value={p.id}>{p.avatar_emoji || '📁'} {p.name}</option>)}
              </select>
            )}
          </div>

          {created ? (
            <div className="rounded-md border border-green-300 bg-green-50 p-2 text-sm text-green-800">
              Issue #{created.number} created{created.runId ? ' — an agent is on it' : ''}.{' '}
              {created.url && <a href={created.url} target="_blank" rel="noreferrer" className="underline">View</a>}
              <button onClick={() => { setCreated(null); }} className="ml-2 text-xs underline">Report another</button>
            </div>
          ) : (
            <>
              <TriageCopilot
                projectId={projectId}
                pageContext={{ route: typeof window !== 'undefined' ? window.location.pathname : undefined }}
                onDraft={(d) => setDraft({ title: d.title, body: d.body, assign: d.assign_to_agent })}
              />
              {draft && (
                <div className="space-y-1.5 rounded-md border border-[var(--gray-5)] p-2">
                  <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className="w-full rounded-md border px-2 py-1 text-sm" />
                  <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={5} className="w-full rounded-md border px-2 py-1 text-xs font-mono" />
                  <label className="flex items-center gap-1.5 text-xs text-[var(--gray-11)]">
                    <input type="checkbox" checked={!!draft.assign} onChange={(e) => setDraft({ ...draft, assign: e.target.checked })} />
                    Hand to a software engineer agent
                  </label>
                  <button onClick={create} disabled={creating || !draft.title.trim()}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                    {creating ? 'Creating…' : 'Create issue'}
                  </button>
                </div>
              )}
              {err && <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800">{err}</div>}
            </>
          )}
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-12 w-12 items-center justify-center rounded-full bg-purple-600 text-xl leading-none text-white shadow-lg hover:bg-purple-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 focus-visible:ring-offset-2"
        aria-label={open ? 'Close feedback' : 'Report feedback'}
        aria-expanded={open}
      >
        {open ? '×' : '💬'}
      </button>
    </div>
  );
}
