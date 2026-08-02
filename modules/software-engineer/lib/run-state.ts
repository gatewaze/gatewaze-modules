// @ts-nocheck
/**
 * Shared helpers for advancing a run through the state machine and recording its
 * phases, gates, live events, and chat messages. All writes go through the service-role
 * supabase client (workers bypass RLS by design).
 */

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
  tokens?: { model?: string; input?: number; output?: number },
) {
  const patch = {
    status,
    summary: summary ?? null,
    model: tokens?.model ?? null,
    tokens_input: tokens?.input ?? 0,
    tokens_output: tokens?.output ?? 0,
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
