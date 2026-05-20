/**
 * Per-source sync handler — replaces ai.sync-one-skill-source +
 * ai.sync-one-recipe-source after the unification.
 *
 * Delegates to lib/agents/sync-agent-source.ts (which orchestrates the
 * skill + recipe passes sequentially). Same trigger string semantics
 * as before: 'cron' | 'webhook' | 'manual' for telemetry.
 */

import { createClient } from '@supabase/supabase-js';
import WebSocketImpl from 'ws';
import { syncAgentSource } from '../lib/agents/sync-agent-source.js';
import { skillsConfig } from '../lib/skills/skills-config.js';

interface JobInput {
  data: {
    kind?: string;
    source_id?: string;
    trigger?: 'cron' | 'webhook' | 'manual';
  };
  id?: string | number;
}

interface RuntimeContext {
  logger?: {
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
    error: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

export default async function syncOneAgentSourceHandler(
  job: JobInput,
  ctx?: RuntimeContext,
): Promise<unknown> {
  if (!skillsConfig.skillsEnabled) {
    ctx?.logger?.info('agents.killswitch', { jobId: job.id });
    return { skipped: true, reason: 'killswitch' };
  }

  const sourceId = job.data?.source_id;
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    return { skipped: true, reason: 'missing_source_id' };
  }

  const trigger: 'cron' | 'webhook' | 'manual' =
    job.data?.trigger === 'webhook' || job.data?.trigger === 'manual'
      ? job.data.trigger
      : 'cron';

  const supabase = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    {
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: { transport: WebSocketImpl as never },
    },
  );

  const result = await syncAgentSource({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    sourceId,
    trigger,
    ...(ctx?.logger ? { logger: ctx.logger } : {}),
  });

  return result;
}
