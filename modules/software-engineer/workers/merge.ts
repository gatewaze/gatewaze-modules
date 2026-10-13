// @ts-nocheck
/**
 * merge phase (§7/§10, multi-repo). Auto-merges the run's PRs only when the project allows it
 * (auto_merge_safe + blast safe) AND GitHub reports each PR mergeable_state 'clean' (required checks
 * green). The token is non-bypass, so a red PR simply can't be merged: unmergeable PRs are left open.
 * A PR that is only 'behind' (out of date with base, under strict protection) is self-healed by an
 * "update branch" so a later tick can merge it once checks re-run clean.
 * The pr-monitor finalizes (all merged → close the issue + archive).
 */
import { createClient } from '@supabase/supabase-js';
import { getProject, getCodeRepos } from '../lib/credentials.js';
import { canAutoMergeRepo } from '../lib/repo-merge-policy.js';
import { redactToken } from '../lib/git.js';
import { mergeRunPrs } from '../lib/merge-prs.js';
import { recordPhaseStart, recordPhaseEnd, blockRun } from '../lib/run-state.js';

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
  const repos = await getCodeRepos(supabase,run.project_id);
  if (!repos.some(repo => canAutoMergeRepo(repo,project,run))) {
    return { skipped: 'not eligible for auto-merge' };
  }
  const token = project.githubToken;

  await recordPhaseStart(supabase, run, 'merge');
  try {
    const { merged, held, results } = await mergeRunPrs(supabase, run, project, { autonomous: true });
    await recordPhaseEnd(supabase, run, 'merge', 'passed', `merged ${merged} PR(s); ${held} held`);
    if (results.some(r => r.reason === 'verification_required')) {
      const {data:last} = await supabase.from('se_phases').select('attempt').eq('run_id',run.id).eq('phase','verify').order('attempt',{ascending:false}).limit(1).maybeSingle();
      await supabase.from('se_runs').update({status:'queued',current_phase:'verify'}).eq('id',run.id);
      await ctx?.enqueueJob?.('se','software-engineer:verify',{runId:run.id,attempt:(last?.attempt ?? 0)+1});
      return {ok:true,merged,held,reverify:true};
    }
    // pr-monitor finalizes (all merged → close issue + archive; else stay watching).
    await ctx?.enqueueJob?.('se', 'software-engineer:pr-monitor', { runId: run.id });
    return { ok: true, merged, held };
  } catch (e) {
    const msg = redactToken(e?.message || String(e), token);
    await recordPhaseEnd(supabase, run, 'merge', 'blocked', msg);
    await supabase.from('se_runs').update({ status: 'watching', error: msg }).eq('id', run.id);
    return { held: true, error: msg };
  }
}
