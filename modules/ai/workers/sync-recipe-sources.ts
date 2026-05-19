/**
 * Fan-out cron handler — runs every 5 minutes per the module manifest.
 *
 * Parallel to `sync-skill-sources.ts`: queries `ai_recipe_sources` for
 * rows that are due (not currently syncing, or whose lock has expired)
 * and enqueues one `ai.sync-one-recipe-source` job per match.
 *
 * Per spec-ai-workflows-and-skill-interop.md §4.12 + §3.1, the
 * fan-out / per-source split mirrors the skill workers so BullMQ
 * dedupe per source, parallel processing across sources, and
 * telemetry per role all carry over unchanged.
 */

import { createClient } from '@supabase/supabase-js';
import WebSocketImpl from 'ws';

import { recipesConfig } from '../lib/recipes/recipes-config.js';

interface JobInput {
  data: { kind?: string };
  id?: string | number;
}

interface RuntimeContext {
  logger?: {
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
    error: (msg: string, fields?: Record<string, unknown>) => void;
  };
  enqueueJob?: (queue: string, name: string, data: Record<string, unknown>) => Promise<{ id: string }>;
}

interface DueSource {
  id: string;
}

export default async function syncRecipeSourcesHandler(
  job: JobInput,
  ctx?: RuntimeContext,
): Promise<unknown> {
  if (!recipesConfig.recipesEnabled) {
    ctx?.logger?.info('recipes.killswitch', { jobId: job.id });
    return { skipped: true, reason: 'killswitch', enqueued: 0 };
  }

  const supabase = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    {
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: { transport: WebSocketImpl as never },
    },
  );

  // Due = NOT currently syncing, OR lock expired. The per-source
  // worker re-claims the lock atomically, so worst case multiple jobs
  // fire and N-1 of them exit immediately.
  const res = await supabase
    .from('ai_recipe_sources')
    .select('id')
    .or(`sync_status.neq.syncing,sync_lock_expires_at.lt.${new Date().toISOString()}`);

  const due = (res?.data as DueSource[] | null) ?? [];
  ctx?.logger?.info('recipes.fanout.scan', { due: due.length });

  if (!ctx?.enqueueJob) {
    ctx?.logger?.warn('recipes.fanout.no_enqueue_helper', {
      due: due.length,
      hint: 'platform runtime did not supply enqueueJob — fan-out is a no-op',
    });
    return { skipped: true, reason: 'no_enqueue_helper', enqueued: 0 };
  }

  let enqueued = 0;
  for (const source of due) {
    try {
      await ctx.enqueueJob('jobs', 'ai.sync-one-recipe-source', {
        kind: 'ai.sync-one-recipe-source',
        source_id: source.id,
        trigger: 'cron',
      });
      enqueued += 1;
    } catch (err) {
      ctx?.logger?.warn('recipes.fanout.enqueue_failed', {
        sourceId: source.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { enqueued, scanned: due.length };
}
