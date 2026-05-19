/**
 * Worker handler — processes a single `ai.sync-one-skill-source`
 * job. Delegates to `lib/skills/sync-source.ts` (where the real work
 * lives, kept off the worker entrypoint so it's unit-testable
 * separately).
 *
 * Per spec-ai-skills.md §4.1 trigger paths — this handler runs for
 * cron-fan-out, webhook-triggered, and "Sync now" admin jobs alike.
 * The trigger string is carried on the job for telemetry only; the
 * sync behaviour is identical across triggers.
 */

import { createClient } from '@supabase/supabase-js';
import WebSocketImpl from 'ws';
import { syncSource } from '../lib/skills/sync-source.js';
import { skillsConfig } from "../lib/skills/skills-config.js";

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

export default async function syncOneSkillSourceHandler(
  job: JobInput,
  ctx?: RuntimeContext,
): Promise<unknown> {
  if (!skillsConfig.skillsEnabled) {
    ctx?.logger?.info('skills.killswitch', { jobId: job.id });
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

  const result = await syncSource({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    sourceId,
    trigger,
    ...(ctx?.logger ? { logger: ctx.logger } : {}),
  });

  return result;
}
