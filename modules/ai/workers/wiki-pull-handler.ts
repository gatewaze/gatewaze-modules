/**
 * Worker handler — ai:wiki-pull. Reconciles git → DB (last-writer-wins +
 * conflict flag) for human/Obsidian edits pushed to the remote. Triggered
 * by the git webhook or a manual "Pull now". spec-ai-memory-wiki.md §7.2.
 */

import { runWikiPull } from '../lib/wiki/sync.js';
import { buildWikiSyncDeps, resolveGitToken, ensureRemoteBranch, loadSyncTarget } from '../lib/wiki/worker-support.js';

interface JobInput {
  data?: { useCase?: string };
  id?: string | number;
}

interface RuntimeContext {
  logger?: {
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

export default async function wikiPullHandler(job: JobInput, ctx?: RuntimeContext): Promise<unknown> {
  const log = ctx?.logger ?? {
    info: (msg: string, fields?: Record<string, unknown>) => console.log(`[ai.wiki-pull] ${msg}`, fields ?? ''),
    warn: (msg: string, fields?: Record<string, unknown>) => console.warn(`[ai.wiki-pull] ${msg}`, fields ?? ''),
  };

  const useCase = job.data?.useCase;
  if (!useCase) {
    log.warn('missing_use_case', { job_id: job.id });
    return { ok: false, error: 'missing_use_case' };
  }

  const deps = buildWikiSyncDeps();
  const target = await loadSyncTarget(deps, useCase);
  if (!target?.git_remote) {
    log.info('no_remote', { useCase });
    return { ok: true, pulled: 0, reason: 'no_remote' };
  }

  try {
    await ensureRemoteBranch(target.git_remote, target.git_branch ?? 'main', resolveGitToken(), useCase);
    const r = await runWikiPull(deps, useCase);
    log.info('pull_done', { useCase, ...r });
    return { ok: true, ...r };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('pull_failed', { useCase, error: message });
    await deps.supabase.from('ai_wiki_sync_state').update({ last_error: message }).eq('use_case', useCase);
    return { ok: false, error: message };
  }
}
