/**
 * Worker handler — processes a single `ai:run-recipe` job.
 *
 * Lifecycle per spec-ai-job-runner §4.1:
 *   1. Hydrate the run row (set status='running').
 *   2. Rehydrate ParsedRecipe + sub_recipes from the snapshot on the row.
 *   3. Subscribe to the cancel pub/sub channel.
 *   4. Stream events to Redis Stream as the executor runs.
 *   5. On terminal event, EXPIRE the stream.
 *   6. Release the per-use-case semaphore in `finally`.
 *
 * Cancellation is honoured via:
 *   - the CancelToken supplied to runRecipe (which the executor's
 *     existing isCancelled() DB poll already consults).
 *   - we also set ai_recipe_runs.cancel_requested_at when pub/sub fires,
 *     so the executor's DB poll picks it up at the next step boundary.
 */

import { createClient } from '@supabase/supabase-js';
import { runRecipe, type RunRecipeArgs } from '../lib/recipes/run-recipe.js';
import type { ParsedRecipe } from '../lib/recipes/parse-recipe.js';
import { broadcastCancel, RunCancelled, subscribeCancel } from '../lib/jobs/cancel.js';
import { releaseUseCaseSemaphore } from '../lib/jobs/enqueue.js';
import { incConcurrency, recordCompleted } from '../lib/jobs/metrics.js';
import { getRedisClient } from '../lib/jobs/redis-client.js';
import { appendStreamEvent } from '../lib/jobs/stream-writer.js';
import {
  recipeRunCancelChannel,
  recipeRunStreamKey,
  STREAM_TTL_SECONDS,
} from '../lib/jobs/stream-keys.js';

interface JobInput {
  data: {
    runId?: string;
    useCase?: string;
    userId?: string | null;
  };
  id?: string | number;
  attemptsMade?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opts?: any;
}

interface RuntimeContext {
  logger?: {
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
    error: (msg: string, fields?: Record<string, unknown>) => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveFetchUrl?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveGatewazeSearch?: any;
}

export default async function runRecipeHandler(
  job: JobInput,
  ctx?: RuntimeContext,
): Promise<unknown> {
  const runId = job.data?.runId;
  const useCase = job.data?.useCase ?? 'unknown';
  if (typeof runId !== 'string' || runId.length === 0) {
    return { skipped: true, reason: 'missing_runId' };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const streamKey = recipeRunStreamKey(runId);
  const cancelChannel = recipeRunCancelChannel(runId);
  const redis = await getRedisClient();

  // Hydrate the run row.
  const rowRes = await supabase
    .from('ai_recipe_runs')
    .select('id, status, recipe_id, recipe_file_path, recipe_snapshot, sub_recipes_snapshot, params, user_id, use_case, host_kind, host_id')
    .eq('id', runId)
    .maybeSingle();
  if (rowRes.error || !rowRes.data) {
    ctx?.logger?.error('ai.run-recipe.row_missing', { runId, error: rowRes.error?.message });
    return { skipped: true, reason: 'run_row_missing' };
  }
  const row = rowRes.data as {
    id: string;
    status: string;
    recipe_id: string | null;
    recipe_file_path: string | null;
    recipe_snapshot: Record<string, unknown> | null;
    sub_recipes_snapshot: Record<string, Record<string, unknown>> | null;
    params: Record<string, unknown>;
    user_id: string | null;
    use_case: string;
    host_kind: string | null;
    host_id: string | null;
  };

  // Cancel-before-pickup short-circuit.
  if (row.status === 'cancelled' || row.status === 'cancelling') {
    await appendStreamEvent(redis, streamKey, { type: 'run.cancelled', reason: 'admin' });
    await redis.expire(streamKey, STREAM_TTL_SECONDS);
    await releaseUseCaseSemaphore(useCase);
    return { cancelled: true, reason: 'cancelled_before_pickup' };
  }

  if (!row.recipe_snapshot) {
    await markFailed(supabase, runId, 'recipe_snapshot missing on run row');
    await appendStreamEvent(redis, streamKey, {
      type: 'run.failed',
      error: { code: 'snapshot_missing', message: 'recipe_snapshot missing on run row' },
    });
    await redis.expire(streamKey, STREAM_TTL_SECONDS);
    await releaseUseCaseSemaphore(useCase);
    throw new Error('UnrecoverableError: recipe_snapshot missing');
  }

  const recipe = row.recipe_snapshot as unknown as ParsedRecipe;
  const subRecipes = new Map<string, ParsedRecipe>();
  if (row.sub_recipes_snapshot && typeof row.sub_recipes_snapshot === 'object') {
    for (const [k, v] of Object.entries(row.sub_recipes_snapshot)) {
      subRecipes.set(k, v as unknown as ParsedRecipe);
    }
  }

  // Subscribe to cancel pub/sub.
  const cancelToken = await subscribeCancel(cancelChannel);

  // Metric: concurrency gauge up; we DECrement in `finally`.
  await incConcurrency('ai:run-recipe', 1);
  const runStart = Date.now();

  // Emit run.start + immediate EXPIRE so a SIGKILL between here and
  // the `finally` block still leaves a bounded-lifetime key.
  await appendStreamEvent(redis, streamKey, {
    type: 'run.start',
    recipeId: row.recipe_id ?? 'inline',
  });
  await redis.expire(streamKey, STREAM_TTL_SECONDS);

  const args: RunRecipeArgs = {
    recipe,
    subRecipes,
    params: row.params as never,
    userId: row.user_id,
    useCase: row.use_case,
    ...(row.host_kind && { hostKind: row.host_kind }),
    ...(row.host_id && { hostId: row.host_id }),
    ...(row.recipe_id && { recipeId: row.recipe_id }),
    ...(row.recipe_file_path && { recipeFilePath: row.recipe_file_path }),
    runId: row.id,
    async onStepStart(idx, step) {
      await appendStreamEvent(redis, streamKey, {
        type: 'step.start',
        step_index: idx,
        step_id: step.step_id,
        ...(step.step_label && { step_label: step.step_label }),
      });
    },
    async onStepComplete(idx, out) {
      // step.complete with skipped/failed status is also emitted by
      // the executor so the UI sees a uniform stream of events.
      await appendStreamEvent(redis, streamKey, {
        type: 'step.complete',
        step_index: idx,
        structured: out.structured,
        cost_micro_usd: out.cost_micro_usd,
      });
    },
  };

  // We attach a poller that watches the cancel token and writes the
  // DB cancel column if pub/sub fires — this is the cross-channel
  // backstop the executor's existing isCancelled() check consumes.
  const cancelPoller = setInterval(async () => {
    if (cancelToken.cancelled) {
      await supabase
        .from('ai_recipe_runs')
        .update({ cancel_requested_at: new Date().toISOString(), status: 'cancelling' })
        .eq('id', runId)
        .in('status', ['queued', 'running']);
      clearInterval(cancelPoller);
    }
  }, 500);

  try {
    const result = await runRecipe(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { supabase: supabase as any, logger: ctx?.logger, resolveFetchUrl: ctx?.resolveFetchUrl, resolveGatewazeSearch: ctx?.resolveGatewazeSearch },
      args,
    );

    if (result.status === 'cancelled') {
      await appendStreamEvent(redis, streamKey, {
        type: 'run.cancelled',
        reason: cancelToken.reason,
      });
      return { cancelled: true, reason: cancelToken.source ?? 'unknown' };
    }
    if (result.status === 'failed' || result.status === 'budget_blocked') {
      await appendStreamEvent(redis, streamKey, {
        type: 'run.failed',
        error: {
          code: result.status,
          message: result.failure_reason ?? 'unknown_failure',
        },
      });
      if (await shouldRetry(supabase, row.use_case, job)) {
        throw new Error(result.failure_reason ?? 'recipe_failed');
      }
      return { failed: true, reason: result.failure_reason };
    }
    await appendStreamEvent(redis, streamKey, {
      type: 'run.complete',
      final_output: result.final_output,
      total_cost_micro_usd: result.total_cost_micro_usd,
    });
    return result;
  } catch (err) {
    if (err instanceof RunCancelled) {
      await appendStreamEvent(redis, streamKey, {
        type: 'run.cancelled',
        reason: err.reason,
      });
      return { cancelled: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    await markFailed(supabase, runId, msg);
    await appendStreamEvent(redis, streamKey, {
      type: 'run.failed',
      error: { code: 'worker_exception', message: msg },
    });
    if (await shouldRetry(supabase, row.use_case, job)) throw err;
    return { failed: true, reason: msg };
  } finally {
    clearInterval(cancelPoller);
    await cancelToken.unsubscribe();
    // Idempotent EXPIRE refresh — covers the SIGKILL-before-initial-EXPIRE case.
    try {
      await redis.expire(streamKey, STREAM_TTL_SECONDS);
    } catch {
      // best effort
    }
    await appendStreamEvent(redis, streamKey, { type: 'close' });
    await releaseUseCaseSemaphore(useCase);
    await incConcurrency('ai:run-recipe', -1);
    // Final status is captured from the latest DB row — we re-read so
    // success/fail/cancel are accurate even on a thrown exception path.
    try {
      const after = await supabase
        .from('ai_recipe_runs')
        .select('status')
        .eq('id', runId)
        .maybeSingle();
      const status = (after?.data?.status as string | undefined) ?? 'failed';
      const mapped: 'complete' | 'failed' | 'cancelled' =
        status === 'complete' ? 'complete' : status === 'cancelled' ? 'cancelled' : 'failed';
      await recordCompleted('ai:run-recipe', useCase, mapped, (Date.now() - runStart) / 1000);
    } catch {
      // best effort
    }
  }

  void broadcastCancel;
}

async function markFailed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  runId: string,
  reason: string,
): Promise<void> {
  await supabase
    .from('ai_recipe_runs')
    .update({ status: 'failed', failure_reason: reason, completed_at: new Date().toISOString() })
    .eq('id', runId);
}

async function shouldRetry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  useCase: string,
  job: JobInput,
): Promise<boolean> {
  // BullMQ attempts: 1 = no retry; 2 = allow one retry. allow_retry
  // controls whether the queue accepts retries; BullMQ enforces the
  // count.
  const attemptsMade = Number(job.attemptsMade ?? 0);
  const attempts = Number(job.opts?.attempts ?? 1);
  if (attemptsMade >= attempts) return false;
  const r = await supabase
    .from('ai_use_cases')
    .select('allow_retry')
    .eq('id', useCase)
    .maybeSingle();
  return Boolean(r?.data?.allow_retry);
}
