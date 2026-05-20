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

  if (!ctx?.enqueueJob) {
    ctx?.logger?.warn('agents.fanout.no_enqueue_helper', {
      due: due.length,
      hint: 'platform runtime did not supply enqueueJob — fan-out is a no-op',
    });
    return { skipped: true, reason: 'no_enqueue_helper', enqueued: 0 };
  }

  let enqueued = 0;
  for (const source of due) {
    try {
      await ctx.enqueueJob('jobs', 'ai.sync-one-agent-source', {
        kind: 'ai.sync-one-agent-source',
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
