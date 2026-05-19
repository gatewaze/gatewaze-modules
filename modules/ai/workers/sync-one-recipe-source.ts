/**
 * Worker handler — processes a single `ai.sync-one-recipe-source` job.
 * Delegates to `lib/recipes/sync-source.ts`. Parallels
 * `sync-one-skill-source.ts` exactly; the trigger string is carried
 * for telemetry only.
 */

import { createClient } from '@supabase/supabase-js';
import WebSocketImpl from 'ws';
import { syncRecipeSource } from '../lib/recipes/sync-source.js';
import { recipesConfig } from '../lib/recipes/recipes-config.js';

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

export default async function syncOneRecipeSourceHandler(
  job: JobInput,
  ctx?: RuntimeContext,
): Promise<unknown> {
  if (!recipesConfig.recipesEnabled) {
    ctx?.logger?.info('recipes.killswitch', { jobId: job.id });
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

  const result = await syncRecipeSource({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    sourceId,
    trigger,
    ...(ctx?.logger ? { logger: ctx.logger } : {}),
  });

  return result;
}
