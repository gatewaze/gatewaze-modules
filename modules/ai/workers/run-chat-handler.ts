/**
 * Worker handler — processes a single `ai:run-chat` job.
 *
 * Replaces the in-process `runBackground` that POST
 * /admin/threads/:id/messages used to spawn. Same logic, lifted into a
 * proper BullMQ worker so it survives API restarts, gets retries on
 * opt-in use cases, and surfaces in the Jobs tab.
 *
 * Per spec-ai-job-runner §3.2 + §4.1.
 */

import { createClient } from '@supabase/supabase-js';
import { runChat } from '../lib/runner.js';
import { resolveUseCasePrompt } from '../lib/use-case-prompt.js';
import { subscribeCancel } from '../lib/jobs/cancel.js';
import { releaseUseCaseSemaphore } from '../lib/jobs/enqueue.js';
import { incConcurrency, recordCompleted } from '../lib/jobs/metrics.js';
import { getRedisClient } from '../lib/jobs/redis-client.js';
import { appendStreamEvent } from '../lib/jobs/stream-writer.js';
import {
  messageCancelChannel,
  STREAM_TTL_SECONDS,
  threadStreamKey,
} from '../lib/jobs/stream-keys.js';

interface JobInput {
  data: {
    threadId?: string;
    assistantMessageId?: string;
    useCase?: string;
    userId?: string | null;
    provider?: string;
    model?: string;
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

export default async function runChatHandler(
  job: JobInput,
  ctx?: RuntimeContext,
): Promise<unknown> {
  const threadId = job.data?.threadId;
  const assistantMessageId = job.data?.assistantMessageId;
  const useCase = job.data?.useCase ?? 'unknown';
  if (typeof threadId !== 'string' || typeof assistantMessageId !== 'string') {
    return { skipped: true, reason: 'missing_ids' };
  }

  const supabase = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const streamKey = threadStreamKey(threadId);
  const cancelChannel = messageCancelChannel(assistantMessageId);
  const redis = await getRedisClient();

  // Hydrate the assistant message row.
  const msgRes = await supabase
    .from('ai_messages')
    .select('id, status, thread_id, cancel_requested_at')
    .eq('id', assistantMessageId)
    .maybeSingle();
  if (msgRes.error || !msgRes.data) {
    return { skipped: true, reason: 'message_row_missing' };
  }
  const msgRow = msgRes.data as {
    id: string;
    status: string;
    thread_id: string;
    cancel_requested_at: string | null;
  };

  if (msgRow.status === 'cancelled' || msgRow.status === 'cancelling') {
    return { cancelled: true, reason: 'cancelled_before_pickup' };
  }

  // Hydrate the thread.
  const threadRes = await supabase
    .from('ai_threads')
    .select('id, use_case, created_by')
    .eq('id', threadId)
    .maybeSingle();
  if (threadRes.error || !threadRes.data) {
    await markMessageFailed(supabase, assistantMessageId, 'thread_row_missing');
    return { failed: true, reason: 'thread_row_missing' };
  }
  const threadRow = threadRes.data as {
    id: string;
    use_case: string;
    created_by: string | null;
  };

  await supabase
    .from('ai_messages')
    .update({ status: 'running' })
    .eq('id', assistantMessageId);

  const cancelToken = await subscribeCancel(cancelChannel);

  // The cross-channel cancel backstop: when pub/sub fires, write the
  // cancel column on the message row. The currently running provider
  // call won't notice (runChat doesn't poll), but if it ever does
  // (post v1.1 with mid-turn token streaming + cancel hooks) it will.
  const cancelPoller = setInterval(async () => {
    if (cancelToken.cancelled) {
      await supabase
        .from('ai_messages')
        .update({ cancel_requested_at: new Date().toISOString(), status: 'cancelling' })
        .eq('id', assistantMessageId)
        .in('status', ['queued', 'running']);
      clearInterval(cancelPoller);
    }
  }, 500);

  // Build conversation history.
  const history = await supabase
    .from('ai_messages')
    .select('role, content, status, created_at')
    .eq('thread_id', threadId)
    .neq('id', assistantMessageId)
    .order('created_at', { ascending: true });
  const messages = (history.data ?? [])
    .filter(
      (m: { status: string; role: string }) =>
        m.status === 'complete' && (m.role === 'user' || m.role === 'assistant'),
    )
    .map((m: { role: string; content: string }) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

  // Resolve system prompt + emit run.start to the thread stream.
  const resolved = await resolveUseCasePrompt(supabase as never, threadRow.use_case);

  await incConcurrency('ai:run-chat', 1);
  const runStart = Date.now();

  await appendStreamEvent(redis, streamKey, {
    type: 'run.start',
    recipeId: `chat:${threadId}`,
  });
  await redis.expire(streamKey, STREAM_TTL_SECONDS);

  try {
    const result = await runChat(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        supabase: supabase as any,
        logger: ctx?.logger,
        resolveFetchUrl: ctx?.resolveFetchUrl,
        resolveGatewazeSearch: ctx?.resolveGatewazeSearch,
      } as never,
      {
        useCase: threadRow.use_case,
        userId: threadRow.created_by,
        threadId,
        messageId: assistantMessageId,
        systemPrompt: resolved.systemPrompt,
        messages,
        ...(job.data.provider && { provider: job.data.provider as 'auto' }),
        ...(job.data.model && { model: job.data.model }),
        // Token-streaming hook — every text delta from the provider
        // becomes a `token` event on the thread stream. Spec §4.2.
        onToken: (delta: string): void => {
          void appendStreamEvent(redis, streamKey, { type: 'token', delta });
        },
      },
    );

    // Cancel can fire AFTER runChat returns (we're past the provider
    // call but before the row update). Honour the latest signal.
    if (cancelToken.cancelled) {
      await supabase
        .from('ai_messages')
        .update({ status: 'cancelled', content: result.narrative ?? '' })
        .eq('id', assistantMessageId);
      await appendStreamEvent(redis, streamKey, { type: 'run.cancelled', reason: cancelToken.reason });
      return { cancelled: true };
    }

    await supabase
      .from('ai_messages')
      .update({
        status: 'complete',
        content: result.narrative,
        structured: result.structured,
        provider: result.provider,
        model: result.model,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cost_micro_usd: result.costMicroUsd,
        latency_ms: result.latencyMs,
      })
      .eq('id', assistantMessageId);
    await supabase
      .from('ai_threads')
      .update({
        status: 'ready',
        last_error: null,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cost_micro_usd: result.costMicroUsd,
      })
      .eq('id', threadId);
    await appendStreamEvent(redis, streamKey, {
      type: 'assistant.complete',
      messageId: assistantMessageId,
      cost_micro_usd: result.costMicroUsd,
      tokens_in: result.inputTokens,
      tokens_out: result.outputTokens,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx?.logger?.warn('ai.run-chat.failed', { threadId, assistantMessageId, error: message });
    await markMessageFailed(supabase, assistantMessageId, message);
    await supabase
      .from('ai_threads')
      .update({ status: 'failed', last_error: message })
      .eq('id', threadId);
    await appendStreamEvent(redis, streamKey, {
      type: 'run.failed',
      error: { code: 'provider_error', message },
    });
    if (await shouldRetry(supabase, useCase, job)) throw err;
    return { failed: true, reason: message };
  } finally {
    clearInterval(cancelPoller);
    await cancelToken.unsubscribe();
    try {
      await redis.expire(streamKey, STREAM_TTL_SECONDS);
    } catch {
      // best effort
    }
    await appendStreamEvent(redis, streamKey, { type: 'close' });
    await releaseUseCaseSemaphore(useCase);
    await incConcurrency('ai:run-chat', -1);
    try {
      const after = await supabase
        .from('ai_messages')
        .select('status')
        .eq('id', assistantMessageId)
        .maybeSingle();
      const status = (after?.data?.status as string | undefined) ?? 'failed';
      const mapped: 'complete' | 'failed' | 'cancelled' =
        status === 'complete' ? 'complete' : status === 'cancelled' ? 'cancelled' : 'failed';
      await recordCompleted('ai:run-chat', useCase, mapped, (Date.now() - runStart) / 1000);
    } catch {
      // best effort
    }
  }
}

async function markMessageFailed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  messageId: string,
  message: string,
): Promise<void> {
  await supabase
    .from('ai_messages')
    .update({
      status: 'failed',
      error_code: 'provider_error',
      error_message: message,
    })
    .eq('id', messageId);
}

async function shouldRetry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  useCase: string,
  job: JobInput,
): Promise<boolean> {
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
