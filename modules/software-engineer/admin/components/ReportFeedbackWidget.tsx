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
import { ChatBubbleLeftRightIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { supabase } from '@/lib/supabase';
import TriageCopilot from './TriageCopilot';
import { projectOptionLabel } from './projectAvatarUtils';
import {
  attachmentsPayload, droppedAttachmentsWarning, extFromMime, feedbackImagePath, validateImageFile,
} from './feedback-attachments';

// Absolute API base on deployed admins (nginx serves the SPA only — no /api proxy); '' locally → Vite proxy.
const API = `${(import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_URL ?? ''}/api/modules/software-engineer/admin`;

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
  const [atts, setAtts] = useState<any[]>([]);   // pasted/dropped screenshots → uploaded to `media`

  useEffect(() => {
    api('/projects')
      .then((d) => { const l = d?.projects ?? []; if (l.length) { setProjects(l); setProjectId(l[0].id); } })
      .catch(() => { /* not an SE admin → widget stays hidden */ });
  }, []);

  if (!projects) return null;

  // Paste/drop/pick a screenshot → upload to the public `media` bucket, then send its URL with the
  // issue so the agent downloads + Reads it (same path as the Issues tab; see feedback-attachments.ts).
  const uploadImage = async (file: File) => {
    const v = validateImageFile(file);
    if (!v.ok) { if (v.error) setErr(v.error); return; }
    const key = crypto.randomUUID();
    const ext = extFromMime(file.type);
    const path = feedbackImagePath(projectId, key, ext);
    setAtts((a) => [...a, { key, name: file.name || `${key}.${ext}`, url: '', uploading: true }]);
    try {
      const { error } = await supabase.storage.from('media').upload(path, file, { upsert: false, cacheControl: '3600', contentType: file.type });
      if (error) throw error;
      const { data } = supabase.storage.from('media').getPublicUrl(path);
      setAtts((a) => a.map((x) => (x.key === key ? { ...x, uploading: false, url: data.publicUrl } : x)));
    } catch (e: any) { setErr(`image upload failed: ${String(e?.message ?? e)}`); setAtts((a) => a.filter((x) => x.key !== key)); }
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
    if (!draft?.title?.trim() || creating || uploading) return;
    setCreating(true); setErr(null);
    try {
      const res = await api('/issues', { method: 'POST', body: JSON.stringify({
        project_id: projectId, title: draft.title.trim(), body: draft.body ?? '', assign_to_agent: !!draft.assign,
        attachments: attachmentsPayload(atts),
      }) });
      // The server drops any attachment URL its SSRF allowlist rejects (e.g. an http://…localhost
      // storage URL in dev). We surface that in the success box rather than a silent success.
      setCreated(res); setDraft(null); setAtts([]);
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
                {projects.map((p) => <option key={p.id} value={p.id}>{projectOptionLabel(p.avatar_emoji, p.name)}</option>)}
              </select>
            )}
          </div>

          {created ? (
            <div className="rounded-md border border-green-300 bg-green-50 p-2 text-sm text-green-800">
              Issue #{created.number} created{created.runId ? ' — an agent is on it' : ''}.{' '}
              {created.url && <a href={created.url} target="_blank" rel="noreferrer" className="underline">View</a>}
              <button onClick={() => { setCreated(null); }} className="ml-2 text-xs underline">Report another</button>
              {droppedAttachmentsWarning(created.attachmentsDropped) && (
                <div className="mt-1.5 text-xs font-normal text-amber-700">{droppedAttachmentsWarning(created.attachmentsDropped)}</div>
              )}
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
                  <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                    onPaste={onPaste} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}
                    rows={5} placeholder="Describe the problem…  (paste or drop a screenshot to attach)" className="w-full rounded-md border px-2 py-1 text-xs font-mono" />
                  {atts.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {atts.map((a) => (
                        <div key={a.key} className="relative group">
                          {a.url
                            ? <img src={a.url} alt={a.name} className="h-14 w-14 rounded border object-cover" />
                            : <div className="h-14 w-14 rounded border flex items-center justify-center bg-[var(--gray-2)] text-[10px] text-[var(--gray-10)]">…</div>}
                          <button type="button" onClick={() => removeAtt(a.key)} className="absolute -top-1.5 -right-1.5 rounded-full bg-[var(--gray-12)] text-[var(--gray-1)] size-4 leading-none text-[11px] opacity-0 group-hover:opacity-100" aria-label="Remove">×</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1.5 text-xs text-[var(--gray-11)]">
                      <input type="checkbox" checked={!!draft.assign} onChange={(e) => setDraft({ ...draft, assign: e.target.checked })} />
                      Hand to a software engineer agent
                    </label>
                    <label className="text-xs text-[var(--gray-10)] hover:text-[var(--gray-12)] cursor-pointer underline">
                      Attach image<input type="file" accept="image/*" multiple onChange={onPick} className="hidden" />
                    </label>
                  </div>
                  <button onClick={create} disabled={creating || uploading || !draft.title.trim()}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                    {creating ? 'Creating…' : uploading ? 'Uploading…' : 'Create issue'}
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
        {open ? <XMarkIcon className="size-6" aria-hidden /> : <ChatBubbleLeftRightIcon className="size-6" aria-hidden />}
      </button>
    </div>
  );
}
