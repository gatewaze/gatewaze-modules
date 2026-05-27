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

  // Build conversation history. For assistant messages that carry a
  // structured payload (recipe-shaped candidate list), surface the
  // candidates' source_hrefs alongside the narrative so the model can
  // see what's been shown and avoid emitting duplicates on follow-up.
  // Without this, the assistant content was just the narrative — the
  // model had no way to know which items already exist.
  const history = await supabase
    .from('ai_messages')
    .select('role, content, status, structured, created_at')
    .eq('thread_id', threadId)
    .neq('id', assistantMessageId)
    .order('created_at', { ascending: true });
  const messages = (history.data ?? [])
    .filter(
      (m: { status: string; role: string }) =>
        m.status === 'complete' && (m.role === 'user' || m.role === 'assistant'),
    )
    .map((m: { role: string; content: string; structured: Record<string, unknown> | null }) => {
      let content = m.content ?? '';
      if (m.role === 'assistant' && m.structured && typeof m.structured === 'object') {
        const candidates = (m.structured as { candidates?: unknown }).candidates;
        if (Array.isArray(candidates) && candidates.length > 0) {
          const lines = candidates
            .map((c) => {
              if (!c || typeof c !== 'object') return null;
              const o = c as Record<string, unknown>;
              const t = typeof o.title === 'string' ? o.title : '';
              const h = typeof o.source_href === 'string' ? o.source_href : '';
              return t || h ? `- ${t} (${h})` : null;
            })
            .filter((x): x is string => x !== null);
          if (lines.length > 0) {
            content = `${content}\n\nCandidates already surfaced (do not re-emit on follow-up):\n${lines.join('\n')}`;
          }
        }
      }
      return { role: m.role as 'user' | 'assistant', content };
    });

  // Resolve system prompt + emit run.start to the thread stream.
  const resolved = await resolveUseCasePrompt(supabase as never, threadRow.use_case);

  // When the use case is bound to a recipe with a response.json_schema,
  // chat follow-ups should produce the SAME structured output the
  // recipe's first run did so the widget can render candidate cards
  // on every reply, not just the initial recipe run.
  //
  // We deliberately DO NOT inject the recipe's `instructions` block —
  // those describe the orchestration the recipe runner already did
  // (delegate sub-recipes, merge results, etc.) and confuse the chat
  // model into trying to re-orchestrate something it has no tools for.
  // Instead, give it a chat-appropriate role + the recipe's schema.
  let chatSystemPrompt = resolved.systemPrompt;
  let chatResponseSchema: Record<string, unknown> | null = null;
  if (resolved.source === 'recipe') {
    const recipeMeta = resolved.promptSource?.system_prompt?.kind === 'recipe'
      ? (resolved.promptSource.system_prompt as { recipe?: { recipe_id?: string; title?: string; source_id?: string } }).recipe
      : undefined;
    if (recipeMeta?.recipe_id) {
      const rr = await supabase
        .from('ai_recipes')
        .select('response_schema, sub_recipe_refs')
        .eq('id', recipeMeta.recipe_id)
        .maybeSingle();
      const row = (rr.data as { response_schema?: Record<string, unknown>; sub_recipe_refs?: unknown } | null) ?? null;
      // If the parent recipe declares sub_recipes, prefer ONE of them
      // as the chat template — they hold the actual research
      // instructions ("fetch X, return Y") and a research schema
      // without merger-specific fields like found_by. The parent's
      // own schema is the MERGER's contract and is wrong for a
      // single-model chat turn. This lets operators open a chat tab
      // for ANY model (Gemini 3 Pro, Haiku 4.5, anything) and have
      // it run the same per-pass research job with that model.
      let chatInstructions: string | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const subRecipeRefs = (rr.data as any)?.sub_recipe_refs ?? [];
      if (Array.isArray(subRecipeRefs) && subRecipeRefs.length > 0) {
        const firstRef = subRecipeRefs[0] as { path?: string; name?: string };
        if (firstRef?.path && recipeMeta.source_id) {
          const subRes = await supabase
            .from('ai_recipes')
            .select('instructions, response_schema')
            .eq('source_id', recipeMeta.source_id)
            .eq('file_path', firstRef.path)
            .maybeSingle();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const subRow = (subRes.data as any) ?? null;
          if (subRow?.response_schema && typeof subRow.response_schema === 'object') {
            row.response_schema = subRow.response_schema;
            chatInstructions = typeof subRow.instructions === 'string' ? subRow.instructions : null;
          }
        }
      }
      if (row?.response_schema && typeof row.response_schema === 'object') {
        // Strip recipe-runner-specific fields from the per-item schema
        // before showing it to the chat model. `found_by` only makes
        // sense in the dual-model recipe (which sub-recipe surfaced
        // the candidate); in chat there are no sub-recipes, so forcing
        // the model to set it makes it hallucinate a "merge" narrative
        // ("sonnet surfaced 10, gpt-5 returned 0 ..."). Drop the field
        // from required + properties so the model just emits the
        // candidate fields it can actually populate.
        chatResponseSchema = stripFieldFromSchema(row.response_schema, ['candidates', 'items'], 'found_by');
        const recipeTitle = recipeMeta.title ?? 'this recipe';
        chatSystemPrompt = [
          ...(chatInstructions ? [
            '## Research task',
            '',
            chatInstructions,
            '',
            '---',
            '',
          ] : []),
          `You are running a research turn for the "${recipeTitle}" use case.`,
          chatInstructions
            ? 'The task instructions above describe what to do. Run them using YOUR model (whatever model is executing this chat turn) — not by dispatching sub-recipes; in chat mode there are no sub-recipes to dispatch.'
            : 'Use your available web-search / fetch tools to answer the user. You are operating in chat mode — there is no "merger" or "sub-recipe" context here.',
          'Answer as YOURSELF in first person: "I searched...", "I found...". Do not narrate about sub-recipes, parallel passes, or merging — those concepts are not relevant in this chat.',
          '',
          '## Response format',
          '',
          'Your reply MUST be a single JSON object conforming to this JSON Schema:',
          '',
          '```json',
          JSON.stringify(chatResponseSchema, null, 2),
          '```',
          '',
          'Return ONLY the JSON object. Do not wrap it in markdown code fences. Do not include any prose before or after the JSON. The chat widget rendering your reply parses the JSON directly — text outside the JSON object will not display.',
          'For `narrative`, write a short factual sentence describing what you did and found, in first person.',
          'For `candidates[]`, emit ONLY NEW items. The prior conversation already surfaced candidates with their `source_href`s — do NOT include any candidate whose `source_href` already appears in the history below. Find the NEXT items (the ones not yet shown).',
        ].join('\n');
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
 * Walk down `path` in a JSON-schema-shaped object and remove `field`
 * from the leaf's `required` list and `properties` map. Returns a
 * deep-cloned schema; the input is left untouched. No-op if any step
 * of the path is missing.
 *
 * Used to drop recipe-runner-specific fields (e.g. `found_by`) from
 * the schema the chat model sees, since those fields only make sense
 * in the recipe's multi-pass merge context.
 */
function stripFieldFromSchema(
  schema: Record<string, unknown>,
  path: string[],
  field: string,
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cursor: any = cloned;
  for (const segment of path) {
    if (segment === 'items') {
      if (cursor && typeof cursor === 'object' && 'items' in cursor) {
        cursor = cursor.items;
      } else {
        return cloned;
      }
    } else {
      // Treat as a property name on a "properties" map.
      const props = cursor?.properties;
      if (props && typeof props === 'object' && segment in props) {
        cursor = props[segment];
      } else {
        return cloned;
      }
    }
  }
  if (cursor && typeof cursor === 'object') {
    if (Array.isArray(cursor.required)) {
      cursor.required = cursor.required.filter((f: unknown) => f !== field);
    }
    if (cursor.properties && typeof cursor.properties === 'object') {
      delete cursor.properties[field];
    }
  }
  return cloned;
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
