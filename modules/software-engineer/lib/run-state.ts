// @ts-nocheck
/**
 * Shared helpers for advancing a run through the state machine and recording its
 * phases, gates, live events, and chat messages. All writes go through the service-role
 * supabase client (workers bypass RLS by design).
 */

import { pricePhaseCostUSD } from './cost.js';

const now = () => new Date().toISOString();

export async function recordPhaseStart(sb: unknown, run: any, phase: string) {
  // Upsert (not insert) so a re-run of a phase — e.g. the review→spec retry loop — reuses its
  // row instead of violating the unique (run_id, phase, attempt) constraint and failing the run.
  await sb.from('se_phases').upsert(
    {
      run_id: run.id,
      site_id: run.site_id,
      phase,
      attempt: 1,
      status: 'running',
      started_at: now(),
      finished_at: null,
      summary: null,
      error: null,
    },
    { onConflict: 'run_id,phase,attempt' },
  );
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
    /** Agent SDK total_cost_usd — the fallback when the model has no ai_model_prices row. */
    cost?: number;
  },
) {
  // Price from the ai module's price book (cache-aware, operator-editable) so SE costs agree with
  // the platform AI dashboards; fall back to the SDK's own figure for models the book doesn't know.
  let costUSD: number | null = null;
  if (tokens?.model) {
    try {
      costUSD = await pricePhaseCostUSD(sb, tokens.model, {
        input: tokens.input ?? 0,
        output: tokens.output ?? 0,
        cacheRead: tokens.cacheRead ?? 0,
        cacheCreation: tokens.cacheCreation ?? 0,
      }, { provider: tokens.engine === 'codex' ? 'openai' : 'anthropic' });
    } catch { /* pricing is best-effort — never fail the phase for it */ }
    if (costUSD == null && typeof tokens.cost === 'number' && tokens.cost > 0) {
      costUSD = Math.round(tokens.cost * 10000) / 10000;
    }
  }
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
    finished_at: now(),
  };
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
  // Keep the run's denormalised total in sync (phases run sequentially per run, so a recompute
  // here is race-free and survives phase re-runs/attempts better than incrementing). Best-effort
  // like the pricing call above: a transient DB blip here must not fail a phase whose real work
  // already succeeded (callers re-enter recordPhaseEnd as 'failed' from their catch blocks).
  if (costUSD != null) {
    try {
      const { data: rows } = await sb.from('se_phases').select('cost_usd').eq('run_id', run.id);
      const total = (rows ?? []).reduce((s: number, r: any) => s + (Number(r.cost_usd) || 0), 0);
      await sb.from('se_runs').update({ cost_usd: Math.round(total * 10000) / 10000 }).eq('id', run.id);
    } catch { /* denorm total is best-effort */ }
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

/** Terminal block: record the gate + a blocked phase + set the run blocked. */
export async function blockRun(sb: unknown, run: any, phase: string, gate: string, reason: string) {
  await writeGate(sb, run, gate, 'block', { reason });
  await recordPhaseEnd(sb, run, phase, 'blocked', reason);
  await sb.from('se_runs').update({ status: 'blocked', error: reason }).eq('id', run.id);
  return { blocked: reason };
}
