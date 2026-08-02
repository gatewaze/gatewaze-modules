// @ts-nocheck
/**
 * Project memory — human-approval review surface (the memory-poisoning gate).
 *
 * The reflect phase folds what a run learned into a PROPOSED memory update and writes it to a
 * PENDING slot. That proposal derives from the run's spec, which is influenced by whoever can apply
 * the trigger label (an attacker-influenceable surface) — so it is NEVER injected into any future
 * run until an admin approves it here. Approve promotes pending → live; reject discards it. Until
 * then, only the current LIVE memory reaches runs. This panel is the ONLY UI path that changes what
 * a project's engineers see across runs, so it stays deliberately explicit (confirm on both actions).
 *
 * Backed by the admin API added alongside the gate:
 *   GET  /projects/:id/memory          → { live, pending, hasPending }
 *   POST /projects/:id/memory/approve  → promote pending to live, clear pending
 *   POST /projects/:id/memory/reject   → discard pending, live unchanged
 * All three are admin-gated server-side (same is_admin predicate as the rest of Setup).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Badge, Button } from '@/components/ui';
import { BookOpenIcon, CheckIcon, XMarkIcon, ArrowPathIcon, ChevronRightIcon } from '@heroicons/react/24/outline';

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

const docBox = 'max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3 text-[12px] leading-relaxed font-mono';

export default function MemoryReviewSection({ projectId, onMessage, onChanged }: { projectId: string; onMessage?: (m: { ok?: boolean; text: string }) => void; onChanged?: () => void }) {
  const [mem, setMem] = useState<{ live: string; pending: string; hasPending: boolean; pendingSpecs: Array<{ issue: number; title: string; body: string }> }>({ live: '', pending: '', hasPending: false, pendingSpecs: [] });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showLive, setShowLive] = useState(false);
  const [openSpec, setOpenSpec] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!projectId) { setMem({ live: '', pending: '', hasPending: false, pendingSpecs: [] }); return; }
    setLoading(true);
    try {
      const d = await api(`/projects/${projectId}/memory`);
      setMem({ live: d?.live ?? '', pending: d?.pending ?? '', hasPending: !!d?.hasPending, pendingSpecs: d?.pending_specs ?? [] });
    } catch (e: any) {
      onMessage?.({ text: String(e?.message ?? e) });
    } finally {
      setLoading(false);
    }
  }, [projectId, onMessage]);

  useEffect(() => { load(); }, [load]);

  const approve = async () => {
    if (busy) return;
    if (!window.confirm('Approve this proposal? It becomes the project\'s live memory and is injected into every future run. Only approve after reading it — the content is derived from an attacker-influenceable spec.')) return;
    setBusy(true);
    try { await api(`/projects/${projectId}/memory/approve`, { method: 'POST' }); onMessage?.({ ok: true, text: 'Memory approved — now live.' }); await load(); onChanged?.(); }
    catch (e: any) { onMessage?.({ text: String(e?.message ?? e) }); }
    finally { setBusy(false); }
  };
  const reject = async () => {
    if (busy) return;
    if (!window.confirm('Discard this pending proposal? The live memory is unchanged.')) return;
    setBusy(true);
    try { await api(`/projects/${projectId}/memory/reject`, { method: 'POST' }); onMessage?.({ ok: true, text: 'Proposal discarded.' }); await load(); onChanged?.(); }
    catch (e: any) { onMessage?.({ text: String(e?.message ?? e) }); }
    finally { setBusy(false); }
  };
  const specAction = async (issue: number, action: 'approve' | 'reject') => {
    if (busy) return;
    const msg = action === 'approve'
      ? `Approve the spec for issue #${issue}? It becomes searchable memory for every future run (and linked projects). Specs auto-approve when their PR merges — this one never merged, so read it first.`
      : `Discard the pending spec for issue #${issue}? (The specs/ file in the issues repo is unaffected — only agent-searchable memory.)`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    try { await api(`/projects/${projectId}/specs/${issue}/${action}`, { method: 'POST' }); onMessage?.({ ok: true, text: `Spec #${issue} ${action === 'approve' ? 'approved' : 'discarded'}.` }); await load(); onChanged?.(); }
    catch (e: any) { onMessage?.({ text: String(e?.message ?? e) }); }
    finally { setBusy(false); }
  };

  return (
    <section className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center gap-2 font-medium">
        <BookOpenIcon className="size-4" />
        Project memory
        {mem.hasPending
          ? <Badge color="amber" variant="soft" size="1">pending review</Badge>
          : <Badge color="gray" variant="soft" size="1">no proposal</Badge>}
        <button onClick={load} disabled={loading || busy} title="Refresh"
          className="ml-auto inline-flex items-center gap-1 text-xs text-[var(--gray-11)] hover:text-[var(--gray-12)] disabled:opacity-50">
          <ArrowPathIcon className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />Refresh
        </button>
      </div>
      <p className="text-xs text-[var(--gray-10)]">
        Durable knowledge shared across this project's repos and every future run. After a run, the agent
        <em> proposes</em> an update; it is held here and never reaches a run until you approve it — the proposal is
        derived from an attacker-influenceable spec, so this is a deliberate human gate. Read the proposal before approving.
      </p>

      {mem.hasPending ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2 dark:border-amber-900/60 dark:bg-amber-950/30">
          <div className="text-xs font-semibold text-amber-800 dark:text-amber-300">Proposed update (not yet live)</div>
          <div className={`${docBox} bg-white/60 dark:bg-black/20`}>{mem.pending}</div>
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" color="green" onClick={approve} disabled={busy}><CheckIcon className="size-4 mr-1" />Approve &amp; make live</Button>
            <Button size="sm" variant="soft" color="red" onClick={reject} disabled={busy}><XMarkIcon className="size-4 mr-1" />Discard</Button>
          </div>
        </div>
      ) : (
        <div className="text-sm text-[var(--gray-11)]">No pending proposal — nothing to review.</div>
      )}

      {/* Pending SPECS: specs auto-approve when their PR merges (the merge is the human judgment);
          anything listed here is from a run that never merged — review before it enters memory. */}
      {mem.pendingSpecs.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2 dark:border-amber-900/60 dark:bg-amber-950/30">
          <div className="text-xs font-semibold text-amber-800 dark:text-amber-300">
            Pending specs ({mem.pendingSpecs.length}) — runs that never merged
          </div>
          {mem.pendingSpecs.map((s) => (
            <div key={s.issue} className="rounded border border-amber-200 bg-white/60 dark:border-amber-900/40 dark:bg-black/20">
              <button onClick={() => setOpenSpec(openSpec === s.issue ? null : s.issue)}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs font-medium">
                <ChevronRightIcon className={`size-3.5 shrink-0 transition-transform ${openSpec === s.issue ? 'rotate-90' : ''}`} />
                {s.title || `Spec — issue #${s.issue}`}
              </button>
              {openSpec === s.issue && (
                <div className="space-y-2 px-2 pb-2">
                  <div className={docBox}>{s.body}</div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" color="green" onClick={() => specAction(s.issue, 'approve')} disabled={busy}><CheckIcon className="size-4 mr-1" />Approve</Button>
                    <Button size="sm" variant="soft" color="red" onClick={() => specAction(s.issue, 'reject')} disabled={busy}><XMarkIcon className="size-4 mr-1" />Discard</Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div>
        <button onClick={() => setShowLive((v) => !v)} className="inline-flex items-center gap-1 text-xs font-medium text-[var(--gray-11)] hover:text-[var(--gray-12)]">
          <ChevronRightIcon className={`size-3.5 transition-transform ${showLive ? 'rotate-90' : ''}`} />
          Current live memory{mem.live ? '' : ' (empty)'}
        </button>
        {showLive && (
          <div className={`${docBox} mt-2`}>{mem.live || '(no memory yet — the first approved proposal starts it)'}</div>
        )}
      </div>
    </section>
  );
}
