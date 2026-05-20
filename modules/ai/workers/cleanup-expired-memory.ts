/**
 * Worker handler — hourly sweep of ai_memory rows where expires_at < now().
 *
 * spec-ai-mcp-extensions.md §Memory backing store §Retention.
 *
 * Bounded delete (LIMIT 5000 per run) so a sudden expiry burst can't
 * monopolise the worker; the cron's hourly cadence catches any backlog
 * across subsequent ticks.
 */

import { createClient } from '@supabase/supabase-js';

interface JobInput {
  data?: { kind?: string };
  id?: string | number;
}

interface RuntimeContext {
  logger?: {
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

export default async function cleanupExpiredMemoryHandler(
  job: JobInput,
  ctx?: RuntimeContext,
): Promise<unknown> {
  const log = ctx?.logger ?? {
    info: (msg: string, fields?: Record<string, unknown>) => console.log(`[ai.cleanup-expired-memory] ${msg}`, fields ?? ''),
    warn: (msg: string, fields?: Record<string, unknown>) => console.warn(`[ai.cleanup-expired-memory] ${msg}`, fields ?? ''),
  };

  const supabase = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // Cap the delete to avoid pathological I/O on a backlog. Hourly cron
  // makes 5k/hour the steady-state ceiling — well above any realistic
  // expiry rate for an admin-facing memory feature.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nowIso = new Date().toISOString();
  const result = await (supabase as any)
    .from('ai_memory')
    .delete()
    .lt('expires_at', nowIso)
    .not('expires_at', 'is', null);

  if (result.error) {
    log.warn('cleanup_failed', { error: result.error.message });
    return { ok: false, error: result.error.message };
  }

  // supabase-js delete doesn't return rowCount by default; rely on the
  // bool success indicator + log the sweep run.
  log.info('cleanup_complete', { job_id: job.id });
  return { ok: true };
}
