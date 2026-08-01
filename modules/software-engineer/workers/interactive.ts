// @ts-nocheck
/**
 * interactive session worker. A manually-started, long-lived Claude Code session on a project — the
 * admin just chats with it (desktop pair-programming feel), there is no issue and no pipeline. Clones
 * the project's code repos into a scratch workspace (writable repos on a fresh throwaway branch), runs
 * ONE persistent streaming session (lib/phase-runner.runInteractiveSession) fed by the admin↔agent
 * Redis bridge, and on close (explicit, idle, or wall-clock cap) discards the workspace and marks the
 * run 'closed' — freeing the interactive slot. The workspace is ephemeral: nothing is pushed in v1.
 *
 * NOT recoverable: unlike issue phases, an interactive session is a live REPL with no persisted step
 * to resume from, so a pod death simply ends it (workers/recover.ts skips kind='interactive'). The
 * caps guarantee an abandoned session can't hold a runner worker indefinitely.
 */
import { createClient } from '@supabase/supabase-js';
import { getProject, getCodeRepos, resolveCommitIdentity } from '../lib/credentials.js';
import { makeMultiWorkspace } from '../lib/worktree.js';
import { runInteractiveSession } from '../lib/phase-runner.js';
import { redactToken } from '../lib/git.js';
import { writeMessage } from '../lib/run-state.js';

const sb = (ctx) =>
  ctx?.supabase ??
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

// Idle cap: no admin message for this long ends the session. Default 15 min. Wall-clock cap reuses the
// project's per_run_wallclock_minutes (falling back to 120 min) so operators tune it in one place.
const IDLE_MS = Number(process.env.SE_INTERACTIVE_IDLE_MS || 15 * 60 * 1000);
const DEFAULT_WALLCLOCK_MIN = Number(process.env.SE_INTERACTIVE_WALLCLOCK_MIN || 120);

export default async function interactive(job, ctx) {
  const supabase = sb(ctx);
  const { data: run } = await supabase.from('se_runs').select('*').eq('id', job?.data?.runId).maybeSingle();
  if (!run) return { skipped: 'no run' };
  if (run.kind !== 'interactive') return { skipped: 'not interactive' };
  // Only a run that is still 'running' should be (re)driven. If it was closed/cancelled before a
  // worker picked it up, do nothing.
  if (run.status !== 'running') return { skipped: `status ${run.status}` };

  const project = await getProject(supabase, run.project_id);
  const finish = async (patch = {}) => {
    await supabase.from('se_runs').update({ status: 'closed', ...patch }).eq('id', run.id).eq('status', 'running');
  };

  if (!project) { await finish({ error: 'project not found' }); return { failed: 'no project' }; }
  if (!project.intakeEnabled) {
    try { await writeMessage(supabase, run, 'system', 'Cannot start: this project is disabled (kill switch).'); } catch {}
    await finish({ error: 'intake disabled' });
    return { failed: 'intake disabled' };
  }
  const token = project.githubToken;
  if (!token) {
    try { await writeMessage(supabase, run, 'system', 'Cannot start: the project has no GitHub credential.'); } catch {}
    await finish({ error: 'project GitHub credential missing' });
    return { failed: 'no token' };
  }

  const wallclockMs = Math.max(1, project.perRunWallclockMinutes || DEFAULT_WALLCLOCK_MIN) * 60_000;
  const codeRepos = (await getCodeRepos(supabase, run.project_id)).slice(0, project.maxCodeReposPerRun);

  let ws;
  try {
    const commitId = await resolveCommitIdentity(supabase, project, token);
    // A fresh throwaway branch per session; writable repos are cut off their base so the agent can
    // freely commit locally. Nothing is pushed — the workspace is discarded on close.
    ws = await makeMultiWorkspace(codeRepos, token, run.branch_name, commitId);

    const kickoff = [
      `You are an interactive software engineer, pair-programming live with an admin in this workspace.`,
      `Introduce yourself in one or two sentences: name the writable repo(s) you can work in, and ask`,
      `what they'd like to work on. Then wait for their message and respond turn by turn. Follow each`,
      `repo's CLAUDE.md / .claude rules exactly. You may read anything and edit only WRITABLE repos.`,
      `This is a scratch session — your changes are NOT pushed or turned into a PR automatically.`,
    ].join(' ');

    const result = await runInteractiveSession(supabase, ctx, run, project, {
      cwd: ws.root,
      kickoff,
      repos: ws.repos,
      allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
      systemAppend: 'Interactive pair-programming session. Never use --no-verify or --force. Do not open PRs unless explicitly asked.',
      idleMs: IDLE_MS,
      wallclockMs,
    });

    if (result?.error) {
      const msg = redactToken(result.error, token);
      try { await writeMessage(supabase, run, 'system', `Session ended with an error: ${msg}`); } catch {}
      await finish({ error: msg });
      return { failed: msg };
    }
    await finish();
    return { ok: true };
  } catch (e) {
    const msg = redactToken(e?.message || String(e), token);
    try { await writeMessage(supabase, run, 'system', `Session ended with an error: ${msg}`); } catch {}
    await finish({ error: msg });
    return { failed: msg };
  } finally {
    try { await ws?.cleanup?.(); } catch { /* ignore */ }
  }
}
