/**
 * Worker handler — ai:wiki-push. Drains a debounced push job (DB → git):
 * reconciles changed pages, writes markdown, commits and pushes. Bootstraps
 * an empty remote on first run. spec-ai-memory-wiki.md §7.1.
 */

import { runWikiPush } from '../lib/wiki/sync.js';
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

export default async function wikiPushHandler(job: JobInput, ctx?: RuntimeContext): Promise<unknown> {
  const log = ctx?.logger ?? {
    info: (msg: string, fields?: Record<string, unknown>) => console.log(`[ai.wiki-push] ${msg}`, fields ?? ''),
    warn: (msg: string, fields?: Record<string, unknown>) => console.warn(`[ai.wiki-push] ${msg}`, fields ?? ''),
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
    return { ok: true, pushed: false, reason: 'no_remote' };
  }

  try {
    const bootstrapped = await ensureRemoteBranch(target.git_remote, target.git_branch ?? 'main', resolveGitToken(), useCase);
    const r = await runWikiPush(deps, useCase);
    log.info('push_done', { useCase, bootstrapped, ...r });
    return { ok: true, bootstrapped, ...r };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('push_failed', { useCase, error: message });
    await deps.supabase.from('ai_wiki_sync_state').update({ last_error: message }).eq('use_case', useCase);
    return { ok: false, error: message };
  }
}
