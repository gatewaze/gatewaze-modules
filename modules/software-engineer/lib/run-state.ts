// @ts-nocheck
/**
 * Shared helpers for advancing a run through the state machine and recording its
 * phases, gates, live events, and chat messages. All writes go through the service-role
 * supabase client (workers bypass RLS by design).
 */

import { pricePhaseCostUSD } from './cost.js';
import { createOrSupersedeDecision } from './decisions.js';

const now = () => new Date().toISOString();

export async function recordPhaseStart(sb: unknown, run: any, phase: string, attempt = 1) {
  // Upsert (not insert) so a re-run of a phase — e.g. the review→spec retry loop — reuses its
  // row instead of violating the unique (run_id, phase, attempt) constraint and failing the run.
  // `attempt` defaults to 1 for the normal single-attempt pipeline path; callers that resume a
  // previously FAILED phase (see admin-routes.ts's /resume) pass an explicit incremented attempt so
  // the prior failure's row is preserved instead of being overwritten by this upsert.
  await sb.from('se_phases').upsert(
    {
      run_id: run.id,
      site_id: run.site_id,
      phase,
      attempt,
      status: 'running',
      started_at: now(),
      finished_at: null,
      summary: null,
      error: null,
      // A reopened (retried) phase must not display the failed attempt's usage; live heartbeat
      // estimates repopulate these within ~20s of the new attempt starting.
      model_usage: null,
      cost_usd: null,
      book_cost_usd: null,
      tokens_input: 0,
      tokens_output: 0,
      tokens_cache_read: 0,
      tokens_cache_creation: 0,
    },
    { onConflict: 'run_id,phase,attempt' },
  );
}

/** Sum se_phases.cost_usd across a run and write the rounded total onto se_runs.cost_usd. Shared
 *  by recordPhaseEnd (phase-close accurate) and the phase-runner heartbeat (keeps the running
 *  phase's live estimate reflected in the same total, not just at phase end). Callers wrap this in
 *  their own best-effort try/catch — a transient DB blip here must never fail the phase/run. */
export async function recomputeRunCost(sb: unknown, run: any) {
  const { data: rows } = await sb.from('se_phases').select('cost_usd').eq('run_id', run.id);
  const total = (rows ?? []).reduce((s: number, r: any) => s + (Number(r.cost_usd) || 0), 0);
  await sb.from('se_runs').update({ cost_usd: Math.round(total * 10000) / 10000 }).eq('id', run.id);
}

export async function recordPhaseEnd(
  sb: unknown,
  run: any,
  phase: string,
  status: 'passed' | 'failed' | 'blocked' | 'skipped',
  summary?: string,
  tokens?: {
    model?: string;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
    /** Which harness ran the phase ('claude' | 'codex'); selects the price-book provider. */
    engine?: string;
    /** Agent SDK total_cost_usd — the PRIMARY cost figure (complete: subagents + harness utility
     *  models at list prices; reconciles with seat billing). Book price is the fallback. */
    cost?: number;
    /** Per-model breakdown from the SDK result ({model: {input, output, cacheRead, cacheCreation, costUSD}}). */
    modelUsage?: Record<string, unknown>;
    /** Explicit attempt for AUX phases (spec-refine/code-refine/architecture-refine) that have no prior
     *  recordPhaseStart 'running' row AND can repeat within one run — pass a distinct attempt (see
     *  nextPhaseAttempt) so each occurrence is its own costed se_phases record instead of colliding on
     *  the (run_id, phase, attempt) unique key. Omit for pipeline phases (default single-attempt path). */
    attempt?: number;
  },
) {
  // Cost preference (migration 018, reversing 012's): the SDK's total_cost_usd is PRIMARY — it is
  // the harness's own complete meter (subagent sessions + utility-model calls the main-thread token
  // fields never see; seat reconciliation measured a ~3.5x gap). The ai_model_prices book price is
  // computed anyway as book_cost_usd for analytics, and stands in for cost_usd only when the SDK
  // reported nothing (e.g. a phase that died before its result message).
  let bookUSD: number | null = null;
  if (tokens?.model) {
    try {
      bookUSD = await pricePhaseCostUSD(sb, tokens.model, {
        input: tokens.input ?? 0,
        output: tokens.output ?? 0,
        cacheRead: tokens.cacheRead ?? 0,
        cacheCreation: tokens.cacheCreation ?? 0,
      }, { provider: tokens.engine === 'codex' ? 'openai' : 'anthropic' });
    } catch { /* pricing is best-effort — never fail the phase for it */ }
  }
  const sdkUSD = typeof tokens?.cost === 'number' && tokens.cost > 0
    ? Math.round(tokens.cost * 10000) / 10000 : null;
  const costUSD = sdkUSD ?? bookUSD;
  const patch = {
    status,
    summary: summary ?? null,
    model: tokens?.model ?? null,
    tokens_input: tokens?.input ?? 0,
    tokens_output: tokens?.output ?? 0,
    tokens_cache_read: tokens?.cacheRead ?? 0,
    tokens_cache_creation: tokens?.cacheCreation ?? 0,
    engine: tokens?.engine ?? (tokens?.model ? 'claude' : null),
    cost_usd: costUSD,
    book_cost_usd: bookUSD,
    model_usage: tokens?.modelUsage && Object.keys(tokens.modelUsage).length ? tokens.modelUsage : null,
    finished_at: now(),
  };
  if (typeof tokens?.attempt === 'number') {
    // AUX phase with an explicit attempt (a refine): no 'running' row was ever opened and the same
    // phase label recurs per refine, so address the row directly by (run_id, phase, attempt).
    await sb.from('se_phases').upsert(
      { run_id: run.id, site_id: run.site_id, phase, attempt: tokens.attempt, ...patch },
      { onConflict: 'run_id,phase,attempt' },
    );
  } else {
    // Close the open 'running' row for this phase; if there isn't one (e.g. blocked before
    // start), insert a terminal row. Avoids a duplicate on unique (run_id, phase, attempt).
    const { data } = await sb
      .from('se_phases')
      .update(patch)
      .eq('run_id', run.id)
      .eq('phase', phase)
      .eq('status', 'running')
      .select('id');
    if (!data || data.length === 0) {
      await sb.from('se_phases').insert({ run_id: run.id, site_id: run.site_id, phase, ...patch });
    }
  }
  // Keep the run's denormalised total in sync (phases run sequentially per run, so a recompute
  // here is race-free and survives phase re-runs/attempts better than incrementing). Best-effort
  // like the pricing call above: a transient DB blip here must not fail a phase whose real work
  // already succeeded (callers re-enter recordPhaseEnd as 'failed' from their catch blocks).
  if (costUSD != null) {
    try { await recomputeRunCost(sb, run); } catch { /* denorm total is best-effort */ }
  }
}

/** Next attempt number for an AUX phase that recurs within a run (the refine workers). Counts the
 *  existing se_phases rows for (run, phase) so each refine gets a distinct attempt and its own costed
 *  record. Best-effort: on a count error, falls back to a timestamp-derived attempt to avoid a
 *  collision rather than clobbering a prior refine's cost. */
export async function nextPhaseAttempt(sb: unknown, runId: string, phase: string): Promise<number> {
  try {
    const { count } = await sb
      .from('se_phases')
      .select('id', { count: 'exact', head: true })
      .eq('run_id', runId)
      .eq('phase', phase);
    return (count ?? 0) + 1;
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

export async function writeGate(
  sb: unknown,
  run: any,
  gate: string,
  verdict: 'pass' | 'block',
  detail?: Record<string, unknown>,
) {
  await sb.from('se_gates').insert({
    run_id: run.id,
    site_id: run.site_id,
    gate,
    verdict,
    detail: detail ?? {},
  });
}

export async function writeEvent(
  sb: unknown,
  run: any,
  phase: string,
  seq: number,
  kind: string,
  payload?: Record<string, unknown>,
) {
  await sb.from('se_events').insert({
    run_id: run.id,
    site_id: run.site_id,
    phase,
    seq,
    kind,
    payload: payload ?? {},
  });
}

export async function writeMessage(
  sb: unknown,
  run: any,
  role: 'admin' | 'agent' | 'system',
  content: string,
  opts?: { author?: string; subSessionId?: string; delivered?: boolean },
) {
  await sb.from('se_messages').insert({
    run_id: run.id,
    site_id: run.site_id,
    role,
    author: opts?.author ?? null,
    sub_session_id: opts?.subSessionId ?? null,
    content,
    delivered_at: opts?.delivered ? now() : null,
  });
}

/**
 * Coarse liveness heartbeat: bump se_runs.updated_at so the Runs tab can tell a live-but-quiet run
 * (long single tool call, model thinking) from a wedged one. Prefer this over inserting se_events
 * rows on a timer — it emits the same realtime signal without growing the event log. The
 * set_updated_at trigger stamps the real time; the value here is only to force a row version.
 */
export async function touchRun(sb: unknown, run: any) {
  await sb.from('se_runs').update({ updated_at: now() }).eq('id', run.id);
}

/** Upsert a per-repo PR row for a multi-repo run (§7). */
export async function upsertRunPr(
  sb: unknown, run: any, repoOwner: string, repoName: string,
  patch: Record<string, unknown>,
) {
  await sb.from('se_run_prs').upsert(
    { run_id: run.id, site_id: run.site_id, repo_owner: repoOwner, repo_name: repoName, ...patch },
    { onConflict: 'run_id,repo_owner,repo_name' },
  );
}

export async function listRunPrs(sb: unknown, runId: string): Promise<any[]> {
  const { data } = await sb.from('se_run_prs').select('*').eq('run_id', runId).order('repo_owner');
  return data ?? [];
}

/**
 * Gate mailbox drain (resume race, SPEC #36 §3.3): an admin note sent right after a resume lands in
 * se_messages with delivered_at=null before the resumed phase's live pub/sub subscriber exists —
 * publishInput (input-channel.ts) would silently drop it. Called once at the top of a phase's agent
 * session; returns a prompt block to prepend (or '' if there's nothing pending) and marks whatever it
 * returns as delivered so a later attempt of the same phase doesn't redeliver it.
 *
 * Only call this when `attempt > 1` (i.e. the phase itself is a resume retry). An ORDINARY chat message
 * sent to an already-running phase also inserts with delivered_at=null — the live subscriber consumes
 * it, but nothing marks the row delivered afterwards (there is no message id in the pub/sub payload to
 * correlate back to). Draining unconditionally on every phase start would re-inject that already-
 * consumed, unrelated chat as a fake "admin note" on every later phase transition for every run, not
 * just resumed ones — gating on attempt keeps this scoped to the case it exists for.
 */
export async function drainPendingAdminMessages(sb: unknown, run: any, attempt: number): Promise<string> {
  if (!attempt || attempt <= 1) return '';
  try {
    const { data: pending } = await sb
      .from('se_messages').select('id, content').eq('run_id', run.id).eq('role', 'admin').is('delivered_at', null).order('id');
    if (!pending?.length) return '';
    await sb.from('se_messages').update({ delivered_at: now() }).in('id', pending.map((m: any) => m.id));
    return `\n--- ADMIN NOTE (steering feedback for this turn) ---\n${pending.map((m: any) => m.content).join('\n\n')}\n`;
  } catch {
    return ''; // best-effort — a dropped note surfaces to the admin, who can resend via chat
  }
}

/** Terminal block: record the gate + a blocked phase + set the run blocked. */
export async function blockRun(sb: unknown, run: any, phase: string, gate: string, reason: string) {
  await writeGate(sb, run, gate, 'block', { reason });
  await recordPhaseEnd(sb, run, phase, 'blocked', reason);
  await sb.from('se_runs').update({ status: 'blocked', error: reason }).eq('id', run.id);
  // config_blocked catch-all (issue #52): kill_switch/authorization blocks are NOT agent-discussable —
  // there is nothing an operator's answer could resolve short of fixing Setup — but the decision row
  // still gives the Overview panel a real question instead of a generic label, and the answer endpoint
  // rejects an answer attempt against it (classifyDecision resolves these to 'config_blocked').
  try {
    await createOrSupersedeDecision(sb, {
      runId: run.id, projectId: run.project_id, siteId: run.site_id, phase,
      question: reason, kind: 'text', context: null,
    });
  } catch { /* best-effort — the Overview panel falls back to classifyDecision() if this row is missing */ }
  return { blocked: reason };
}
