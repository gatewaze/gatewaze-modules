// @ts-nocheck
/**
 * "Decisions needed" panel (issue #49) — one place on the Overview dashboard to see every run
 * parked waiting on a human, in plain language, with a deep link to act. Replaces the two separate
 * "Awaiting spec approval" / "Architecture review" RunListSections (which only covered two of the
 * six DecisionKinds and left the rest of `blocked` an undifferentiated bucket the operator had to
 * click into individually to understand).
 *
 * Fetches GET /overview/decisions on the SAME refresh cadence as the rest of Overview (Realtime on
 * se_runs + the visibility-poll backstop already wired in OverviewView) — no new polling loop here.
 * Renders nothing when there is nothing to decide, exactly like PendingApprovals.
 *
 * Issue #52 made the rows interactive: a row backed by a persisted se_decisions row (d.decisionId
 * set) exposes its actual answer control inline — choice buttons or a text box — POSTing to
 * POST /decisions/:id/answer instead of only deep-linking into the run. A row with no persisted
 * decision yet (classifyDecision()-only label) keeps the old click-to-open-run behavior.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { fmtCost, formatDuration } from './overview-filters';
import { ProjectAvatar } from './ProjectAvatar';
import { runLabel } from './RunListSection';
import { KIND_TITLES, groupDecisions, shouldShowArchitectureLink } from './decisionsPanelUtils';

// Absolute API base on deployed admins (nginx serves the SPA only — no /api proxy); '' locally → Vite proxy.
const API = `${(import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? ''}/api/modules/software-engineer/admin`;

async function api(path: string, init?: RequestInit) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const r = await fetch(`${API}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message ?? body?.error ?? `${init?.method ?? 'GET'} ${path} → ${r.status}`);
  return body;
}

// Options that need a free-text reason before they can be submitted — the answer endpoint rejects
// these without text, so the panel asks up front rather than round-tripping a 400.
const OPTIONS_REQUIRING_TEXT = new Set(['request_changes', 'reject']);

function AnswerControl({ decision, onAnswered }: { decision: any; onAnswered: () => void }) {
  const [draft, setDraft] = useState<{ optionId: string | null; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async (optionId: string | null, text: string) => {
    setSubmitting(true);
    setErr(null);
    try {
      await api(`/decisions/${decision.decisionId}/answer`, {
        method: 'POST',
        body: JSON.stringify(decision.answerKind === 'choice' ? { option_id: optionId, text } : { text }),
      });
      setDraft(null);
      onAnswered();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to submit answer');
      setSubmitting(false);
    }
  }, [decision.decisionId, decision.answerKind, onAnswered]);

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  if (decision.answered) {
    return <span className="text-xs italic text-[var(--gray-9)]">Answered — resuming…</span>;
  }

  if (decision.answerKind === 'choice') {
    const options: Array<{ id: string; label: string; description?: string }> = decision.options ?? [];
    // Picked an option that needs text (request_changes/reject): show the text box + confirm/cancel.
    if (draft && OPTIONS_REQUIRING_TEXT.has(draft.optionId ?? '')) {
      return (
        <div className="flex flex-col gap-1 w-full" onClick={stop}>
          <textarea
            autoFocus
            rows={4}
            maxLength={500}
            value={draft.text}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            placeholder="Reason (required)…"
            className="w-full rounded border border-[var(--gray-6)] bg-transparent p-1.5 text-xs"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] tabular-nums text-[var(--gray-9)]">{draft.text.length}/500</span>
            <div className="flex gap-2">
              <button type="button" disabled={submitting} onClick={() => setDraft(null)} className="text-xs text-[var(--gray-10)] hover:underline disabled:opacity-50">
                Cancel
              </button>
              <button
                type="button"
                disabled={submitting || !draft.text.trim()}
                onClick={() => submit(draft.optionId, draft.text)}
                className="rounded bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {submitting ? 'Submitting…' : `Confirm ${options.find((o) => o.id === draft.optionId)?.label ?? draft.optionId}`}
              </button>
            </div>
          </div>
          {err && <div className="text-[10px] text-red-600">{err}</div>}
        </div>
      );
    }
    // Picked an option that doesn't need text (approve): show inline confirm.
    if (draft) {
      return (
        <div className="flex items-center gap-2" onClick={stop}>
          <span className="text-xs text-[var(--gray-10)]">{options.find((o) => o.id === draft.optionId)?.label}?</span>
          <button type="button" disabled={submitting} onClick={() => setDraft(null)} className="text-xs text-[var(--gray-10)] hover:underline disabled:opacity-50">
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => submit(draft.optionId, '')}
            className="rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : 'Confirm'}
          </button>
          {err && <div className="text-[10px] text-red-600">{err}</div>}
        </div>
      );
    }
    return (
      <div className="flex flex-col items-end gap-1" onClick={stop}>
        <div className="flex gap-1.5">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              title={o.description}
              onClick={() => setDraft({ optionId: o.id, text: '' })}
              className={
                'rounded px-2 py-0.5 text-xs font-medium ' +
                (OPTIONS_REQUIRING_TEXT.has(o.id)
                  ? 'text-[var(--gray-10)] hover:bg-[var(--gray-3)]'
                  : 'bg-blue-600 text-white hover:bg-blue-700')
              }
            >
              {o.label}
            </button>
          ))}
        </div>
        {err && <div className="text-[10px] text-red-600">{err}</div>}
      </div>
    );
  }

  // kind === 'text' — a free-text answer (e.g. a distilled review-blocked question with no fixed options).
  const text = draft?.text ?? '';
  return (
    <div className="flex flex-col gap-1 w-full" onClick={stop}>
      <textarea
        rows={4}
        maxLength={500}
        value={text}
        onChange={(e) => setDraft({ optionId: null, text: e.target.value })}
        placeholder="Your answer…"
        className="w-full rounded border border-[var(--gray-6)] bg-transparent p-1.5 text-xs"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] tabular-nums text-[var(--gray-9)]">{text.length}/500</span>
        <button
          type="button"
          disabled={submitting || !text.trim()}
          onClick={() => submit(null, text)}
          className="rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? 'Submitting…' : 'Submit'}
        </button>
      </div>
      {err && <div className="text-[10px] text-red-600">{err}</div>}
    </div>
  );
}

export default function DecisionsPanel({ projectFilter, onOpenRun }: {
  projectFilter?: string;
  onOpenRun?: (id: string) => void;
}) {
  const [decisions, setDecisions] = useState<any[]>([]);

  const load = useCallback(async () => {
    const qs = projectFilter ? `?project=${encodeURIComponent(projectFilter)}` : '';
    try {
      const d = await api(`/overview/decisions${qs}`);
      setDecisions(d?.decisions ?? []);
    } catch { /* transient fetch error — next refresh tick retries */ }
  }, [projectFilter]);

  useEffect(() => {
    load();
    const ch = supabase.channel('se-overview-decisions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'se_runs' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  if (decisions.length === 0) return null;

  const grouped = groupDecisions(decisions);
  const openCount = decisions.filter((d) => !d.answered).length;

  return (
    <section className="rounded-lg border border-[var(--gray-5)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--gray-10)]">Decisions needed</div>
        {openCount > 0 && (
          <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 rounded-full bg-red-100 px-1.5 text-xs font-medium text-red-700">
            {openCount}
          </span>
        )}
      </div>
      <div className="space-y-4">
        {grouped.map(([kind, rows]) => (
          <div key={kind} className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--gray-9)]">{KIND_TITLES[kind]}</div>
            <div className="space-y-1">
              {rows.map((d) => {
                const showProposalLink = shouldShowArchitectureLink(kind, d);
                const interactive = Boolean(d.decisionId) && !d.answered;
                const label = (
                  <div
                    className="flex items-center gap-2 min-w-0 cursor-pointer"
                    onClick={() => onOpenRun?.(d.id)}
                  >
                    <ProjectAvatar emoji={d.project?.avatar_emoji} className="size-4 shrink-0" />
                    <div className="min-w-0">
                      <div className="truncate text-sm text-[var(--gray-12)]">{runLabel(d)}</div>
                      <div className="truncate text-xs text-[var(--gray-10)]">{d.decision}</div>
                    </div>
                  </div>
                );
                return (
                  <div key={d.id} className="flex flex-col gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--gray-2)]">
                    <div className="flex items-center justify-between gap-3">
                      {label}
                      <div className="flex items-center gap-2 shrink-0">
                        {showProposalLink && (
                          <a
                            href={d.architecture_commit_url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-xs text-blue-600 underline hover:text-blue-700"
                          >
                            view proposal
                          </a>
                        )}
                        {!interactive && (
                          <>
                            {formatDuration(d.updated_at) && <span className="text-xs tabular-nums text-[var(--gray-10)]">{formatDuration(d.updated_at)} waiting</span>}
                            {fmtCost(d.cost_usd) && <span className="text-xs font-mono text-[var(--gray-10)]">{fmtCost(d.cost_usd)}</span>}
                          </>
                        )}
                      </div>
                    </div>
                    {interactive && <AnswerControl decision={d} onAnswered={load} />}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
