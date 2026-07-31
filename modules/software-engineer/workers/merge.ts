// @ts-nocheck
/**
 * merge phase (§7/§10, multi-repo). Auto-merges the run's PRs only when the project allows it
 * (auto_merge_safe + blast safe) AND GitHub reports each PR mergeable_state 'clean' (required checks
 * green). The token is non-bypass, so a red PR simply can't be merged: unmergeable PRs are left open.
 * The pr-monitor finalizes (all merged → close the issue + archive).
 */
import { createClient } from '@supabase/supabase-js';
import { getProject } from '../lib/credentials.js';
import { githubClient } from '../lib/github.js';
import { redactToken } from '../lib/git.js';
import { recordPhaseStart, recordPhaseEnd, blockRun, listRunPrs, upsertRunPr } from '../lib/run-state.js';

const sb = (ctx) =>
  ctx?.supabase ??
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

export default async function merge(job, ctx) {
  const supabase = sb(ctx);
  const { data: run } = await supabase.from('se_runs').select('*').eq('id', job?.data?.runId).maybeSingle();
  if (!run) return { skipped: 'no run' };
  if (run.status === 'cancelled' || run.archived_at) return { skipped: 'inactive' };
  const project = await getProject(supabase, run.project_id);
  if (!project?.intakeEnabled) return blockRun(supabase, run, 'merge', 'kill_switch', 'intake disabled');
  if (project.autonomyMode !== 'auto_merge_safe' || run.blast_radius !== 'safe') {
    return { skipped: 'not eligible for auto-merge' };
  }
  const token = project.githubToken;

  await recordPhaseStart(supabase, run, 'merge');
  const gh = githubClient(token);
  try {
    const openPrs = (await listRunPrs(supabase, run.id)).filter((p) => p.pr_number && p.state === 'open');
    let merged = 0, held = 0;
    for (const p of openPrs) {
      try {
        const info = await gh.getPullRequest(p.repo_owner, p.repo_name, p.pr_number);
        if (info.merged || info.merged_at) { await upsertRunPr(supabase, run, p.repo_owner, p.repo_name, { state: 'merged' }); merged++; continue; }
        if (info.mergeable_state !== 'clean') { held++; continue; } // required checks pending/failing/behind
        await gh.mergePullRequest(p.repo_owner, p.repo_name, p.pr_number, 'squash');
        await upsertRunPr(supabase, run, p.repo_owner, p.repo_name, { state: 'merged' });
        merged++;
      } catch { held++; /* protection / race — leave open */ }
    }
    await recordPhaseEnd(supabase, run, 'merge', 'passed', `merged ${merged} PR(s); ${held} held`);
    // pr-monitor finalizes (all merged → close issue + archive; else stay watching).
    await ctx?.enqueueJob?.('jobs', 'software-engineer:pr-monitor', { runId: run.id });
    return { ok: true, merged, held };
  } catch (e) {
    const msg = redactToken(e?.message || String(e), token);
    await recordPhaseEnd(supabase, run, 'merge', 'blocked', msg);
    await supabase.from('se_runs').update({ status: 'watching', error: msg }).eq('id', run.id);
    return { held: true, error: msg };
  }
}
