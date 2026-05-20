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
  /**
   * Optional gatewaze_search resolver. Required when a use case enables
   * the `gatewaze_search` web tool. Backed by Serper.dev or a DDG HTML
   * scrape — see lib/gatewaze-search.ts.
   */
  resolveGatewazeSearch?: (query: string, maxResults: number) => Promise<{
    ok: boolean;
    results: Array<{ title: string; url: string; snippet: string }>;
    backend: 'serper' | 'ddg';
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
  /**
   * Extra tools the model can invoke (MCP servers, builtin: memory).
   * Threaded down to the provider client. Anthropic honours these;
   * OpenAI/Gemini ignore them in this commit (provider parity gap).
   */
  extraTools?: import('./providers/types.js').ExtraTool[];

  /**
   * Token-level streaming callback. When supplied, provider clients
   * use the streaming SDK variant and emit each text delta here.
   * Spec: spec-ai-job-runner §4.2.
   */
  onToken?: (delta: string) => void | Promise<void>;
}

export interface RunChatResult {
  narrative: string;
  structured: Record<string, unknown> | null;
  provider: KnownProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  costMicroUsd: number;
  latencyMs: number;
  fetchedUrls: FetchedUrlAudit[];
  webSearchCount: number;
}

interface UseCaseRow {
  id: string;
  max_output_tokens: number;
  daily_cost_cap_micro_usd: number | null;
  allowed_web_tools: ('web_search' | 'fetch_url' | 'gatewaze_search')[];
}

// ─── runChat ──────────────────────────────────────────────────────────────

/**
 * Goose-CLI chat executor. Activated by AI_CHAT_EXECUTOR=goose. Routes
 * unstructured chat (no structuredTool, no extraTools — those still
 * need provider-native tool schemas) through the Goose session wrapper
 * so MCP allowlists, per-use-case runtime overrides, and the operator-
 * facing memory backing store all apply automatically.
 *
 * Structured-output callers (editor-ai-copilot's emit_page / emit_block_
 * props, recipe runs surfacing `recipe__final_output`) stay on the
 * inline ProviderRouter path until the Goose `goose run --recipe`
 * structured-output bridge is wired through runChat too. They still
 * benefit from the unified entry — every module is now one runChat
 * call away from full Goose routing once the recipe bridge ships.
 */
function shouldRouteThroughGoose(opts: RunChatOpts): boolean {
  if (process.env.AI_CHAT_EXECUTOR !== 'goose') return false;
  if (opts.structuredTool) return false;
  if (opts.extraTools && opts.extraTools.length > 0) return false;
  if (!opts.threadId) return false;
  return true;
}

export async function runChat(
  ctx: RunnerContext,
  opts: RunChatOpts,
): Promise<RunChatResult> {
  if (shouldRouteThroughGoose(opts)) {
    return runChatViaGooseAdapter(ctx, opts);
  }
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
      // Wrap the fetch-url resolver so each call is attributed to this
      // user/thread/message in ai_usage_events.
      const wrappedFetchResolver = ctx.resolveFetchUrl
        ? async (url: string, reason: string) => {
            const fetchStarted = Date.now();
            const fetchResult = await ctx.resolveFetchUrl!(url, reason);
            await recordUsage(ctx.supabase, {
              userId: opts.userId,
              useCase: opts.useCase,
              threadId: opts.threadId,
              messageId: opts.messageId,
              kind: 'tool',
              provider: 'scrapling',
              // We don't know the mode here — the resolver picks it.
              // Default to fast tier; the operator can refine later.
              model: 'fetch_url:fast',
              bytesIn: fetchResult.bytesIn,
              latencyMs: Date.now() - fetchStarted,
              status: fetchResult.ok ? 'ok' : 'error',
              error: fetchResult.error ?? null,
            });
            return fetchResult;
          }
        : undefined;

      // Mirror the same attribution wrap for gatewaze_search. Each
      // invocation records a `kind='tool'` ai_usage_events row tagged
      // with the resolved backend (serper or ddg) so the cost ledger
      // surfaces search spend alongside fetches.
      const wrappedGatewazeSearchResolver = ctx.resolveGatewazeSearch
        ? async (query: string, maxResults: number) => {
            const started = Date.now();
            const searchResult = await ctx.resolveGatewazeSearch!(query, maxResults);
            await recordUsage(ctx.supabase, {
              userId: opts.userId,
              useCase: opts.useCase,
              threadId: opts.threadId,
              messageId: opts.messageId,
              kind: 'tool',
              // The backend chosen at runtime decides the cost line.
              // Serper is paid (~$1/1k → 1_000 micro-USD/call), DDG is
              // free (override with 0 so the row appears but doesn't
              // inflate spend).
              provider: searchResult.backend === 'serper' ? 'serper' : 'scrapling',
              model: searchResult.backend === 'serper' ? 'gatewaze_search:serper' : 'gatewaze_search:ddg',
              costMicroUsdOverride: searchResult.backend === 'serper' ? 1_000 : 0,
              outputTokens: searchResult.results.length,
              latencyMs: Date.now() - started,
              status: searchResult.ok ? 'ok' : 'error',
              error: searchResult.error ?? null,
            });
            return searchResult;
          }
        : undefined;

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
        gatewazeSearchMaxPerTurn: 6,
        resolveFetchUrl: useCase.allowed_web_tools.includes('fetch_url')
          ? wrappedFetchResolver
          : undefined,
        resolveGatewazeSearch: useCase.allowed_web_tools.includes('gatewaze_search')
          ? wrappedGatewazeSearchResolver
          : undefined,
        extraTools: opts.extraTools,
        onToken: opts.onToken,
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
        cacheCreationTokens: result.cacheCreationTokens,
        latencyMs: result.durationMs,
        status: 'ok',
      });

      // Web-search billed-tool cost. Anthropic charges $10 per 1000
      // web_search calls (the only provider currently exposing a billed
      // count via usage.server_tool_use.web_search_requests). OpenAI
      // doesn't have a server-side web_search; Gemini's google_search
      // doesn't return a billable count in the response. We record a
      // separate ai_usage_events row so the unified cost ledger covers
      // it — closes a ~$0.40/day under-count we observed in MTD
      // reconciliation against Anthropic's billing dashboard.
      if (picked.provider === 'anthropic' && result.webSearchCount > 0) {
        try {
          await recordUsage(ctx.supabase, {
            userId: opts.userId,
            useCase: opts.useCase,
            threadId: opts.threadId,
            messageId: opts.messageId,
            kind: 'tool',
            provider: 'anthropic',
            model: 'web_search',
            // $10 / 1000 requests = $0.01 / req = 10_000 micro-USD per
            // request. Source: Anthropic web_search tool pricing as of
            // 2026-05. Override the price-book lookup so this stays
            // accurate even if the catalog row is absent.
            costMicroUsdOverride: result.webSearchCount * 10_000,
            // Reuse output_tokens as the request count for downstream
            // visibility — keeps the row's token columns non-zero so
            // it doesn't look like a phantom $0 entry.
            outputTokens: result.webSearchCount,
            status: 'ok',
          });
        } catch (err) {
          ctx.logger?.warn?.('ai.web_search.record_failed', {
            use_case: opts.useCase,
            web_search_count: result.webSearchCount,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      ctx.logger?.info('ai.chat.complete', {
        use_case: opts.useCase,
        provider: picked.provider,
        model: picked.model,
        attempt,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        web_search_count: result.webSearchCount,
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
        cacheCreationTokens: result.cacheCreationTokens,
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

/**
 * Translates RunChatOpts → runChatViaGoose args. The opts.messages
 * transcript is split: the last user turn becomes the userMessage,
 * everything before it becomes history (preserving role labels with
 * 'tool_result' mapped to 'tool_summary' which the Goose serialiser
 * already accepts).
 *
 * The Goose path returns a different shape; we map it back into
 * RunChatResult so callers see a consistent contract. `fetchedUrls`
 * and `webSearchCount` come back empty for now — Goose's stream-json
 * doesn't yet thread provider-native tool telemetry through. Cost
 * accounting still lands via recordUsage inside runChatViaGoose.
 */
async function runChatViaGooseAdapter(
  ctx: RunnerContext,
  opts: RunChatOpts,
): Promise<RunChatResult> {
  const { runChatViaGoose } = await import('./chat/run-chat-goose.js');

  // Split messages into history + the trailing user turn.
  const msgs = opts.messages.slice();
  let userMessage = '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role === 'user') {
      userMessage = msgs[i]!.content;
      msgs.splice(i, 1);
      break;
    }
  }
  const history: Array<{ role: 'user' | 'assistant' | 'tool_summary'; content: string }> = msgs
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'tool_result' ? 'tool_summary' : (m.role as 'user' | 'assistant'),
      content: m.content,
    }));

  const result = await runChatViaGoose(
    ctx.supabase as unknown as { from(table: string): unknown },
    ctx,
    {
      threadId: opts.threadId!,
      assistantMessageId: opts.messageId ?? opts.threadId!,
      useCase: opts.useCase,
      userId: opts.userId,
      systemPrompt: opts.systemPrompt,
      history,
      userMessage,
      ...(opts.provider && opts.provider !== 'auto' ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    },
  );

  if (!result.ok) {
    throw new ProviderError(
      result.failure_reason ?? 'goose_failed',
      (result.provider ?? 'anthropic') as KnownProvider,
      500,
    );
  }

  return {
    narrative: result.content,
    structured: result.structured,
    provider: (result.provider ?? 'anthropic') as KnownProvider,
    model: result.model ?? '',
    inputTokens: result.total_input_tokens,
    outputTokens: result.total_output_tokens,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    costMicroUsd: result.total_cost_micro_usd,
    latencyMs: result.duration_ms,
    fetchedUrls: [],
    webSearchCount: 0,
  };
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
  /**
   * Reference images passed to the provider as visual conditioning.
   * Each entry is the raw image base64-encoded plus its mime type.
   * Use cases bound to a skill that declares `reference_images:` in
   * its frontmatter automatically get these from the sync cache via
   * resolveUseCasePrompt — pass that result's `referenceImages`
   * straight through. Empty/omitted = text-only generation (today's
   * default behaviour).
   */
  referenceImages?: Array<{ mimeType: string; base64: string }>;
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
    referenceImages: opts.referenceImages,
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
