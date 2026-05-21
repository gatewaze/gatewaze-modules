/**
 * Fan-out cron handler — runs every 5 minutes per the module manifest.
 *
 * Replaces ai.sync-skill-sources + ai.sync-recipe-sources after the
 * source-table unification (migration 024). One ai_agent_sources row
 * per repo; this handler enqueues one ai.sync-one-agent-source job
 * per due source, and that per-source handler syncs BOTH skills and
 * recipes in a single pass via sync-agent-source.ts.
 *
 * Keeping fan-out and per-source work in separate workers gives us
 * BullMQ dedupe per source, parallel processing across sources, and
 * clear telemetry per role.
 */

import { createClient } from '@supabase/supabase-js';
import WebSocketImpl from 'ws';
import { skillsConfig } from '../lib/skills/skills-config.js';

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
  enqueueJob?: (
    queue: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ id: string }>;
}

interface DueSource {
  id: string;
}

export default async function syncAgentSourcesHandler(
  job: JobInput,
  ctx?: RuntimeContext,
): Promise<unknown> {
  // Honour the skills killswitch — same flag that gates the legacy
  // skill cron. Operators flip this when they want to suspend all
  // git syncing during a content migration.
  if (!skillsConfig.skillsEnabled) {
    ctx?.logger?.info('agents.killswitch', { jobId: job.id });
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
  // worker re-claims the lock atomically inside sync-agent-source.ts,
  // so a duplicate enqueue is harmless — N-1 of them exit immediately.
  const res = await supabase
    .from('ai_agent_sources')
    .select('id')
    .or(`sync_status.neq.syncing,sync_lock_expires_at.lt.${new Date().toISOString()}`);

  const due = (res?.data as DueSource[] | null) ?? [];
  ctx?.logger?.info('agents.fanout.scan', { due: due.length });

  // The platform's worker dispatcher doesn't (currently) thread a ctx
  // through to handlers — entry.handler(job) is invoked with just the
  // job. Fall back to a direct BullMQ enqueue when ctx.enqueueJob
  // isn't supplied so the cron fan-out actually runs. The lazy import
  // mirrors the dispatcher's own queue-resolution path.
  const enqueueJob = ctx?.enqueueJob ?? (await loadFallbackEnqueueJob(ctx));
  if (!enqueueJob) {
    ctx?.logger?.warn('agents.fanout.no_enqueue_helper', {
      due: due.length,
      hint: 'neither ctx.enqueueJob nor a fallback BullMQ queue handle could be resolved — fan-out is a no-op',
    });
    return { skipped: true, reason: 'no_enqueue_helper', enqueued: 0 };
  }

  let enqueued = 0;
  for (const source of due) {
    try {
      await enqueueJob('jobs', 'ai:sync-one-agent-source', {
        kind: 'ai:sync-one-agent-source',
        source_id: source.id,
        trigger: 'cron',
      });
      enqueued += 1;
    } catch (err) {
      ctx?.logger?.warn('agents.fanout.enqueue_failed', {
        sourceId: source.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { enqueued, scanned: due.length };
}

/**
 * Resolve a BullMQ queue handle for `jobs` directly, bypassing the
 * platform's ctx-supplied enqueueJob. Used as a fallback when the
 * worker dispatcher doesn't thread a ctx through to handlers (the
 * current shape — entry.handler(job) is called with no ctx). The
 * import-walk mirrors how the daily-briefing handler resolves
 * @gatewaze-modules/ai/lib/recipes/run-recipe.
 */
type EnqueueFn = (queue: string, name: string, data: Record<string, unknown>) => Promise<{ id: string | undefined }>;
async function loadFallbackEnqueueJob(ctx?: { logger?: { warn: (msg: string, fields?: Record<string, unknown>) => void } }): Promise<EnqueueFn | null> {
  try {
    // Prefer the platform's own queue registry — same module the
    // dispatcher uses, so we land on the same Queue instance with the
    // right Redis connection + prefix.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import('@gatewaze/api/lib/queue/index.js' as any).catch(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => import('@gatewaze/api/dist/lib/queue/index.js' as any),
    )) as { getQueue?: (name: string) => { add: (n: string, d: Record<string, unknown>) => Promise<{ id?: string }> } | null };
    if (typeof mod.getQueue !== 'function') return null;
    return async (queueName, jobName, data) => {
      const queue = mod.getQueue!(queueName);
      if (!queue) return { id: undefined };
      const job = await queue.add(jobName, data);
      return { id: job.id };
    };
  } catch (err) {
    ctx?.logger?.warn('agents.fanout.fallback_enqueue_load_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
