// @ts-nocheck
/**
 * Triage copilot chat (SPEC §10.5) — the conversational front-end of POST /issues/triage.
 *
 * The admin describes a problem roughly; each turn the server returns either a clarifying question
 * (rendered as an assistant bubble) or a structured DRAFT ticket. The draft is handed to the parent
 * via onDraft (the Issues form / widget prefills from it) — the copilot itself NEVER creates the
 * issue; the human reviews the draft and confirms through the normal create path.
 *
 * Reused by both §10.5 entry points: the Issues-tab panel (any project) and the in-page
 * "Report feedback" widget (fixed project + pageContext seeded with the admin route).
 */
import React, { useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui';
import { SparklesIcon, PaperAirplaneIcon } from '@heroicons/react/24/outline';

// Absolute API base on deployed admins (nginx serves the SPA only — no /api proxy); '' locally → Vite proxy.
const API = `${(import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? ''}/api/modules/software-engineer/admin`;

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

export default function TriageCopilot({
  projectId,
  pageContext,
  onDraft,
}: {
  projectId: string;
  pageContext?: { route?: string; feature?: string } | null;
  onDraft: (draft: { title: string; body: string; assign_to_agent: boolean; rationale?: string }) => void;
}) {
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drafted, setDrafted] = useState(false);
  const bottom = useRef<HTMLDivElement | null>(null);

  const send = async () => {
    const content = input.trim();
    if (!content || busy || !projectId) return;
    const next = [...messages, { role: 'user' as const, content }];
    setMessages(next); setInput(''); setBusy(true); setErr(null); setDrafted(false);
    try {
      const r = await api('/issues/triage', {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, messages: next, page_context: pageContext ?? undefined }),
      });
      if (r?.type === 'draft') {
        setMessages((m) => [...m, { role: 'assistant', content: `Drafted: **${r.title}**${r.rationale ? `\n_${r.rationale}_` : ''}\n\nThe draft is loaded into the form below — review, edit if needed, and press Create.` }]);
        onDraft({ title: r.title ?? '', body: r.body ?? '', assign_to_agent: !!r.assign_to_agent, rationale: r.rationale });
        setDrafted(true);
      } else if (r?.type === 'questions' && r.message) {
        setMessages((m) => [...m, { role: 'assistant', content: r.message }]);
      } else {
        setErr(r?.message || 'triage failed');
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
      setTimeout(() => bottom.current?.scrollIntoView({ block: 'nearest' }), 50);
    }
  };

  return (
    <div className="rounded-md border border-[var(--gray-5)] bg-[var(--gray-1)] p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--gray-11)]">
        <SparklesIcon className="size-3.5" />
        Describe the problem in your own words — the copilot turns it into a well-formed ticket.
        {pageContext?.route && <span className="ml-auto font-mono text-[10px] text-[var(--gray-9)] truncate max-w-[40%]">{pageContext.route}</span>}
      </div>

      {messages.length > 0 && (
        <div className="max-h-56 space-y-1.5 overflow-y-auto text-sm">
          {messages.map((m, i) => (
            <div key={i} className={`rounded-md px-2.5 py-1.5 whitespace-pre-wrap ${
              m.role === 'user' ? 'bg-[var(--gray-3)] text-[var(--gray-12)]' : 'bg-blue-500/10 text-[var(--gray-12)]'
            }`}>
              {m.content}
            </div>
          ))}
          {busy && <div className="px-2.5 py-1.5 text-xs text-[var(--gray-10)]">thinking…</div>}
          <div ref={bottom} />
        </div>
      )}

      {err && <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800">{err}</div>}
      {drafted && <div className="rounded-md border border-green-300 bg-green-50 p-2 text-xs text-green-800">Draft ready below — review and Create.</div>}

      <div className="flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={messages.length ? 'Answer or add detail…' : 'e.g. "the runs board jumps to the top every time it refreshes"'}
          rows={2}
          disabled={busy}
          className="flex-1 min-w-0 rounded-md border px-3 py-2 text-sm"
        />
        <Button size="sm" onClick={send} disabled={busy || !input.trim() || !projectId} aria-label="Send">
          <PaperAirplaneIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
