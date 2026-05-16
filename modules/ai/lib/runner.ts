/**
 * Top-level runner entry points.
 *
 * Three public functions:
 *   - runChat      — multi-turn conversation with tools + structured output.
 *   - aiEmbed      — batch embedding generation.
 *   - aiGenerateImage — image gen (uploads to caller-supplied storage).
 *
 * Each:
 *   1. Resolves credentials via the provider router.
 *   2. Optionally enforces the use-case's daily cost cap (pre-flight).
 *   3. Invokes the appropriate provider client.
 *   4. Writes one row to ai_usage_events with the resolved cost.
 *   5. Returns the result + cost metadata to the caller.
 *
 * These are the seams every Gatewaze module hits — no other module
 * should construct provider clients itself.
 */

import { ProviderRouter, inferProvider } from './providers/router.js';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  type ConversationMessage,
  type FetchedUrlAudit,
  type KnownProvider,
  type StructuredOutputTool,
} from './providers/types.js';
import { markCredentialFailed } from './credentials.js';
import {
  estimateMaxCost,
  recordUsage,
  sumSpentMicroUsd,
} from './cost.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = { from(table: string): any; rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> };

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

// ─── Common types ─────────────────────────────────────────────────────────

export interface RunnerContext {
  supabase: SupabaseClient;
  /** Optional fetch_url resolver — required when the use-case enables fetch_url. */
  resolveFetchUrl?: (url: string, reason: string) => Promise<{
    ok: boolean;
    content: string;
    bytesIn: number;
    finalUrl: string;
    error?: string;
  }>;
  logger?: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
}

export interface RunChatOpts {
  useCase: string;
  userId: string | null;
  threadId: string | null;
  messageId: string | null;
  systemPrompt: string;
  messages: ConversationMessage[];
  provider?: 'auto' | KnownProvider;
  model?: string;
  structuredTool?: StructuredOutputTool;
  /** When true, the runner skips per-user credentials. Used by cron handlers. */
  systemRun?: boolean;
  /** Per-call overrides (defaults come from the use-case row). */
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface RunChatResult {
  narrative: string;
  structured: Record<string, unknown> | null;
  provider: KnownProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costMicroUsd: number;
  latencyMs: number;
  fetchedUrls: FetchedUrlAudit[];
  webSearchCount: number;
}

interface UseCaseRow {
  id: string;
  max_output_tokens: number;
  daily_cost_cap_micro_usd: number | null;
  allowed_web_tools: ('web_search' | 'fetch_url')[];
}

// ─── runChat ──────────────────────────────────────────────────────────────

export async function runChat(
  ctx: RunnerContext,
  opts: RunChatOpts,
): Promise<RunChatResult> {
  const useCase = await loadUseCase(ctx.supabase, opts.useCase);
  const router = new ProviderRouter(ctx.supabase);

  const picked = await router.pickClient({
    useCase: opts.useCase,
    userId: opts.userId,
    provider: opts.provider ?? 'auto',
    model: opts.model,
    systemRunOnly: opts.systemRun ?? false,
  });
  if (!picked.client.runConversation) {
    throw new Error(`provider '${picked.provider}' does not support runConversation`);
  }

  const maxOutputTokens = opts.maxOutputTokens ?? useCase.max_output_tokens ?? 8000;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  // Pre-flight budget gate (worst-case estimate). Skipped if no cap set.
  if (useCase.daily_cost_cap_micro_usd != null) {
    const inputApprox = approxInputTokens(opts.systemPrompt, opts.messages);
    const estimate = await estimateMaxCost(ctx.supabase, {
      provider: picked.provider,
      model: picked.model,
      inputTokens: inputApprox,
      maxOutputTokens,
    });
    const spentToday = await sumSpentMicroUsd(ctx.supabase, {
      useCase: opts.useCase,
      fromIso: startOfTodayIso(),
    });
    if (spentToday + estimate > useCase.daily_cost_cap_micro_usd) {
      await recordUsage(ctx.supabase, {
        userId: opts.userId,
        useCase: opts.useCase,
        threadId: opts.threadId,
        messageId: opts.messageId,
        kind: 'llm',
        provider: picked.provider,
        model: picked.model,
        status: 'budget_blocked',
        error: `worst-case ${estimate} micro-USD + spent ${spentToday} would exceed cap ${useCase.daily_cost_cap_micro_usd}`,
      });
      throw new ProviderError(
        `budget_exceeded: today's spend for '${opts.useCase}' would breach cap`,
        picked.provider,
        429,
      );
    }
  }

  let attemptError: ProviderError | null = null;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      const result = await picked.client.runConversation({
        systemPrompt: opts.systemPrompt,
        messages: opts.messages,
        structuredTool: opts.structuredTool,
        webTools: useCase.allowed_web_tools,
        maxOutputTokens,
        timeoutMs,
        model: picked.model,
        webSearchMaxPerTurn: 6,
        fetchUrlMaxPerTurn: 8,
        resolveFetchUrl: useCase.allowed_web_tools.includes('fetch_url')
          ? ctx.resolveFetchUrl
          : undefined,
      });

      const usage = await recordUsage(ctx.supabase, {
        userId: opts.userId,
        useCase: opts.useCase,
        threadId: opts.threadId,
        messageId: opts.messageId,
        kind: 'llm',
        provider: picked.provider,
        model: picked.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cachedTokens: result.cachedTokens,
        latencyMs: result.durationMs,
        status: 'ok',
      });

      ctx.logger?.info('ai.chat.complete', {
        use_case: opts.useCase,
        provider: picked.provider,
        model: picked.model,
        attempt,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cost_micro_usd: usage.costMicroUsd,
        credential_source: picked.credentialSource,
      });

      return {
        narrative: result.narrative,
        structured: result.structured,
        provider: picked.provider,
        model: picked.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cachedTokens: result.cachedTokens,
        costMicroUsd: usage.costMicroUsd,
        latencyMs: result.durationMs,
        fetchedUrls: result.fetchedUrls,
        webSearchCount: result.webSearchCount,
      };
    } catch (err) {
      if (err instanceof ProviderError && err.retryable && attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt] ?? 4_000;
        await new Promise((r) => setTimeout(r, delay));
        attemptError = err;
        continue;
      }
      // Non-retryable. Persist a failure usage row + bubble up.
      const status =
        err instanceof ProviderRateLimitError
          ? 'rate_limited'
          : err instanceof ProviderTimeoutError
          ? 'timeout'
          : 'error';
      await recordUsage(ctx.supabase, {
        userId: opts.userId,
        useCase: opts.useCase,
        threadId: opts.threadId,
        messageId: opts.messageId,
        kind: 'llm',
        provider: picked.provider,
        model: picked.model,
        status,
        error: err instanceof Error ? err.message : String(err),
      });
      // If we got a 401 from the provider, mark the credential as failed.
      if (err instanceof ProviderError && err.httpStatus === 401 && picked.credentialId) {
        const table =
          picked.credentialSource === 'user'
            ? 'ai_user_credentials'
            : 'ai_use_case_credentials';
        await markCredentialFailed(ctx.supabase, table, picked.credentialId, 'provider_401');
      }
      throw err;
    }
  }
  // Exhausted retries.
  throw attemptError ?? new Error('runChat exhausted retries without an error');
}

// ─── aiEmbed ──────────────────────────────────────────────────────────────

export interface AiEmbedOpts {
  useCase: string;
  userId: string | null;
  texts: string[];
  model?: string;
  systemRun?: boolean;
}

export interface AiEmbedResult {
  vectors: number[][];
  inputTokens: number;
  model: string;
  costMicroUsd: number;
}

export async function aiEmbed(
  ctx: RunnerContext,
  opts: AiEmbedOpts,
): Promise<AiEmbedResult> {
  const useCase = await loadUseCase(ctx.supabase, opts.useCase);
  const router = new ProviderRouter(ctx.supabase);

  const picked = await router.pickClient({
    useCase: opts.useCase,
    userId: opts.userId,
    provider: 'openai',                  // embeddings only on OpenAI for v1
    model: opts.model ?? useCase.default_model,
    systemRunOnly: opts.systemRun ?? false,
  });
  if (!picked.client.generateEmbedding) {
    throw new Error(`provider '${picked.provider}' does not support generateEmbedding`);
  }

  const started = Date.now();
  const result = await picked.client.generateEmbedding({
    texts: opts.texts,
    model: picked.model,
  });

  const usage = await recordUsage(ctx.supabase, {
    userId: opts.userId,
    useCase: opts.useCase,
    threadId: null,
    messageId: null,
    kind: 'embedding',
    provider: picked.provider,
    model: picked.model,
    inputTokens: result.inputTokens,
    bytesIn: opts.texts.reduce((sum, t) => sum + t.length, 0),
    latencyMs: Date.now() - started,
    status: 'ok',
  });

  return {
    vectors: result.vectors,
    inputTokens: result.inputTokens,
    model: picked.model,
    costMicroUsd: usage.costMicroUsd,
  };
}

// ─── aiGenerateImage ──────────────────────────────────────────────────────

export interface AiGenerateImageOpts {
  useCase: string;
  userId: string | null;
  prompt: string;
  model?: string;
  aspectRatio?: '16:9' | '1:1' | '4:3' | '9:16';
  destination: {
    bucket: string;
    path: string;
  };
  systemRun?: boolean;
}

export interface AiGenerateImageResult {
  storagePath: string;
  mimeType: string;
  prompt: string;
  costMicroUsd: number;
  model: string;
  provider: KnownProvider;
}

export async function aiGenerateImage(
  ctx: RunnerContext,
  opts: AiGenerateImageOpts,
): Promise<AiGenerateImageResult> {
  await loadUseCase(ctx.supabase, opts.useCase);
  const router = new ProviderRouter(ctx.supabase);

  const inferred = opts.model ? inferProvider(opts.model) : null;
  const picked = await router.pickClient({
    useCase: opts.useCase,
    userId: opts.userId,
    provider: inferred ?? 'gemini',
    model: opts.model,
    systemRunOnly: opts.systemRun ?? false,
  });
  if (!picked.client.generateImage) {
    throw new Error(`provider '${picked.provider}' does not support generateImage`);
  }

  const started = Date.now();
  const result = await picked.client.generateImage({
    prompt: opts.prompt,
    model: picked.model,
    aspectRatio: opts.aspectRatio,
  });

  // Upload to caller-supplied destination via supabase storage.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const storage = (ctx.supabase as any).storage as {
    from(bucket: string): {
      upload(
        path: string,
        body: Buffer,
        opts?: { contentType?: string; upsert?: boolean },
      ): Promise<{ error: { message: string } | null }>;
    };
  };
  const upload = await storage.from(opts.destination.bucket).upload(
    opts.destination.path,
    result.imageBytes,
    { contentType: result.mimeType, upsert: false },
  );
  if (upload.error) {
    throw new Error(`storage upload failed: ${upload.error.message}`);
  }

  const usage = await recordUsage(ctx.supabase, {
    userId: opts.userId,
    useCase: opts.useCase,
    threadId: null,
    messageId: null,
    kind: 'image',
    provider: picked.provider,
    model: picked.model,
    imageOutputs: 1,
    latencyMs: Date.now() - started,
    status: 'ok',
  });

  return {
    storagePath: opts.destination.path,
    mimeType: result.mimeType,
    prompt: result.prompt,
    costMicroUsd: usage.costMicroUsd,
    model: picked.model,
    provider: picked.provider,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function loadUseCase(
  supabase: SupabaseClient,
  id: string,
): Promise<UseCaseRow & { default_model: string }> {
  const result = await supabase
    .from('ai_use_cases')
    .select('id, max_output_tokens, daily_cost_cap_micro_usd, allowed_web_tools, default_model')
    .eq('id', id)
    .maybeSingle();
  if (result.error) throw new Error(`use_case lookup: ${result.error.message}`);
  if (!result.data) throw new Error(`use_case '${id}' not registered`);
  return result.data as UseCaseRow & { default_model: string };
}

/** Rough char-based token estimate for the pre-flight budget gate. */
function approxInputTokens(
  systemPrompt: string,
  messages: ConversationMessage[],
): number {
  const chars =
    systemPrompt.length + messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(chars / 4);            // 4 chars/tok is the rule of thumb
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}
