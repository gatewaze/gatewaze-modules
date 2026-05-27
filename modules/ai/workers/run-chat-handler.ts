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
import { runChatViaGoose } from '../lib/chat/run-chat-goose.js';
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

  // Resolve provider/model fallback. The widget passes both via job
  // data, but if absent (older clients, programmatic enqueues) fall
  // back to the use case's default_provider/default_model. Goose's
  // `goose run` has no env-level default in the worker — without
  // either of these, the subprocess exits 1 silently.
  if (!job.data.provider || !job.data.model) {
    const ucRes = await supabase
      .from('ai_use_cases')
      .select('default_provider, default_model')
      .eq('id', threadRow.use_case)
      .maybeSingle();
    const uc = (ucRes.data as { default_provider?: string; default_model?: string } | null) ?? null;
    if (uc) {
      if (!job.data.provider && uc.default_provider && uc.default_provider !== 'auto') {
        job.data.provider = uc.default_provider;
      }
      if (!job.data.model && uc.default_model) {
        job.data.model = uc.default_model;
      }
    }
  }
  // Cross-check provider against model — multi-model chat surfaces
  // (AiChatModelTabs) used to send a fixed default provider for every
  // tab, so the GPT-5 tab was hitting the Anthropic API with
  // model=gpt-5 and getting "Resource not found (404)". Defence in
  // depth: if model is set but provider clearly doesn't serve it,
  // overwrite provider from the model id.
  if (typeof job.data.model === 'string') {
    const inferred = inferProviderFromModel(job.data.model);
    if (inferred && inferred !== 'unknown' && job.data.provider !== inferred) {
      job.data.provider = inferred;
    }
  }

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

  // When the use case is bound to a recipe with a response.json_schema,
  // chat follow-ups should produce the SAME structured output the
  // recipe's first run did — operators expect candidate cards on every
  // assistant turn, not a one-off. Look up the bound recipe and build
  // an enriched system prompt that:
  //   - Includes the recipe's instructions (so the model carries the
  //     visual contract / role / constraints from the recipe).
  //   - Appends the response schema with a hard "respond as JSON only"
  //     directive. Goose's chat path has no native --response-schema
  //     flag; we instruct the model via prompt and parse the JSON out
  //     of stdout below.
  let chatSystemPrompt = resolved.systemPrompt;
  let chatResponseSchema: Record<string, unknown> | null = null;
  if (resolved.source === 'recipe') {
    const recipeMeta = resolved.promptSource?.system_prompt?.kind === 'recipe'
      ? (resolved.promptSource.system_prompt as { recipe?: { recipe_id?: string } }).recipe
      : undefined;
    if (recipeMeta?.recipe_id) {
      const rr = await supabase
        .from('ai_recipes')
        .select('instructions, response_schema')
        .eq('id', recipeMeta.recipe_id)
        .maybeSingle();
      const row = (rr.data as { instructions?: string; response_schema?: Record<string, unknown> } | null) ?? null;
      if (row?.instructions) chatSystemPrompt = row.instructions;
      if (row?.response_schema && typeof row.response_schema === 'object') {
        chatResponseSchema = row.response_schema;
        chatSystemPrompt += `\n\n## Response format\n\nYour response MUST be a single JSON object conforming to this JSON Schema:\n\n\`\`\`json\n${JSON.stringify(chatResponseSchema, null, 2)}\n\`\`\`\n\nReturn ONLY the JSON object. Do not wrap it in markdown code fences. Do not include any prose before or after the JSON. The widget rendering your reply parses the JSON directly.`;
      }
    }
  }

  await incConcurrency('ai:run-chat', 1);
  const runStart = Date.now();

  await appendStreamEvent(redis, streamKey, {
    type: 'run.start',
    recipeId: `chat:${threadId}`,
  });
  await redis.expire(streamKey, STREAM_TTL_SECONDS);

  try {
    // spec-ai-mcp-extensions.md §6 — when AI_CHAT_EXECUTOR=goose, route
    // chat through `goose session` so MCP extensions + memory + runtime
    // overrides all apply identically to recipe runs. Default stays on
    // the legacy in-house runChat path during rollout; flip the env to
    // 'goose' once parity is validated in staging.
    const executor = process.env.AI_CHAT_EXECUTOR ?? 'runChat';
    let result: {
      narrative: string;
      structured: Record<string, unknown> | null;
      provider: string | null;
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      costMicroUsd: number;
      latencyMs: number;
      loaded_mcp_server_names?: string[];
      mcp_warnings?: Array<Record<string, unknown>>;
      goose_runtime_overrides_snapshot?: Record<string, unknown>;
    };
    if (executor === 'goose') {
      // The new turn is the LAST user message in the thread; everything
      // earlier is replayed as history. We hydrated `messages` above
      // from ai_messages; pop the trailing user turn for `userMessage`.
      let userMessage = '';
      const history: Array<{ role: 'user' | 'assistant' | 'tool_summary'; content: string }> = [];
      for (let i = 0; i < messages.length; i++) {
        if (i === messages.length - 1 && messages[i].role === 'user') {
          userMessage = messages[i].content;
        } else {
          history.push({ role: messages[i].role as 'user' | 'assistant', content: messages[i].content });
        }
      }
      const gooseResult = await runChatViaGoose(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        supabase as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          supabase: supabase as any,
          logger: ctx?.logger,
          resolveFetchUrl: ctx?.resolveFetchUrl,
          resolveGatewazeSearch: ctx?.resolveGatewazeSearch,
        } as never,
        {
          threadId,
          assistantMessageId,
          useCase: threadRow.use_case,
          userId: threadRow.created_by,
          systemPrompt: chatSystemPrompt,
          history,
          userMessage,
          ...(job.data.provider && { provider: job.data.provider }),
          ...(job.data.model && { model: job.data.model }),
          // Forward Goose stream events onto the existing thread stream
          // so the chat widget sees deltas without any UI change.
          onStreamEvent: async (event): Promise<void> => {
            // Map Goose's message events to the existing 'token' event
            // shape the widget already renders.
            if (event.type === 'message') {
              const msg = (event.message ?? event) as { content?: unknown[] };
              if (Array.isArray(msg.content)) {
                for (const item of msg.content) {
                  if (item && typeof item === 'object') {
                    const it = item as { type?: string; text?: string };
                    if (it.type === 'text' && typeof it.text === 'string') {
                      await appendStreamEvent(redis, streamKey, { type: 'token', delta: it.text });
                    }
                  }
                }
              }
            }
          },
        },
      );
      if (!gooseResult.ok) {
        throw new Error(gooseResult.failure_reason ?? 'goose chat failed');
      }
      // If the chat use case is recipe-bound (response schema injected
      // above), try to parse the model's reply as JSON conforming to
      // the recipe's response.json_schema. Successful parse → persist
      // to ai_messages.structured so CandidateCards renders the reply
      // the same way the recipe's first turn does. Failed parse →
      // fall through to the plain-text path.
      let parsedNarrative = gooseResult.content;
      let parsedStructured = gooseResult.structured;
      if (chatResponseSchema && parsedStructured === null) {
        const candidate = tryExtractJsonObject(gooseResult.content);
        if (candidate) {
          parsedStructured = candidate;
          parsedNarrative = typeof candidate.narrative === 'string' ? candidate.narrative : '';
        }
      }
      result = {
        narrative: parsedNarrative,
        structured: parsedStructured,
        provider: gooseResult.provider,
        model: gooseResult.model,
        inputTokens: gooseResult.total_input_tokens,
        outputTokens: gooseResult.total_output_tokens,
        costMicroUsd: gooseResult.total_cost_micro_usd,
        latencyMs: gooseResult.duration_ms,
        loaded_mcp_server_names: gooseResult.loaded_mcp_server_names,
        mcp_warnings: gooseResult.mcp_warnings,
      };
    } else {
      result = await runChat(
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
          onToken: (delta: string): void => {
            void appendStreamEvent(redis, streamKey, { type: 'token', delta });
          },
        },
      );
    }

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
        // Snapshot provenance so the chat widget's Run details panel
        // can show which skill/prompt version was used for THIS turn
        // (not just what's configured now). Migration 023.
        prompt_source: resolved.promptSource as unknown as Record<string, unknown>,
        // spec-ai-mcp-extensions.md §Data Models §3.5 — record which
        // MCP servers the spawn actually loaded for this turn + any
        // structured warnings about exclusions.
        ...(result.loaded_mcp_server_names && { loaded_mcp_server_names: result.loaded_mcp_server_names }),
        ...(result.mcp_warnings && { mcp_warnings: result.mcp_warnings }),
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

/**
 * Map a model id back to the provider that serves it. Mirrors the
 * runner-side helper in lib/recipes/run-recipe-goose.ts.
 */
function inferProviderFromModel(model: string): 'anthropic' | 'openai' | 'gemini' | 'unknown' {
  if (model.startsWith('claude') || model.includes('haiku') || model.includes('sonnet') || model.includes('opus')) {
    return 'anthropic';
  }
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) {
    return 'openai';
  }
  if (model.startsWith('gemini')) return 'gemini';
  return 'unknown';
}

/**
 * Best-effort extraction of a JSON object from a model's free-form
 * reply. Handles:
 *   - Raw `{...}` object output
 *   - Output wrapped in ```json fences``` (the model didn't follow
 *     the "no markdown fences" instruction)
 *   - Output with leading/trailing prose (e.g. "Here you go:\n{...}")
 *
 * Returns null when nothing parseable is found.
 */
function tryExtractJsonObject(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  // 1) Direct parse.
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {/* try next */}

  // 2) Fenced ```json ... ``` block.
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (fenceMatch && fenceMatch[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {/* try next */}
  }

  // 3) First `{...}` substring. Scan for matched braces from the first
  //    `{` to find the longest valid object. Simple but tolerates
  //    leading/trailing prose.
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace >= 0) {
    const lastBrace = trimmed.lastIndexOf('}');
    if (lastBrace > firstBrace) {
      try {
        const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {/* give up */}
    }
  }
  return null;
}
