/**
 * Tool-call dispatcher — delegates to @gatewaze-modules/ai's runChat.
 *
 * Phase 2 (Goose Chat unification): the editor no longer maintains its
 * own provider stack. All LLM calls go through the AI module's runChat
 * which:
 *   - picks the provider via ProviderRouter (per-user credentials + the
 *     use_case's default_provider/default_model)
 *   - handles web_search and fetch_url internally (Anthropic native
 *     web_search; fetch_url dispatched to our resolver below)
 *   - records ai_usage_events rows for billing
 *   - automatically routes through Goose when AI_CHAT_EXECUTOR=goose
 *     AND no structured tool is required (editor-ai-copilot's emit_*
 *     calls always carry one, so they currently stay on the inline
 *     ProviderClient path — but every call now lands on the same
 *     canonical entry point, ready to flip when the Goose recipe-
 *     bridge for structured output is ready)
 *
 * The editor's per-call quota + fetch backend selection stays here so
 * we keep the editor's existing Phase-1 cost containment behaviour.
 */
import { canvasAiConfig } from '../canvas-ai-config.js';
import {
  buildSystemPromptWithWebTools,
} from './system-prompt.js';
import {
  bumpTodayUsage,
  readTodayUsage,
  shouldAllowToolCall,
  type SupabaseLikeRpc,
} from './quota.js';
import type {
  FetchedUrlAuditEntry,
  WebSearchAuditEntry,
} from './types.js';
import {
  fetchViaGatewazeFetch,
  type FetchUrlOptions,
} from './fetch-via-gatewaze-fetch.js';
import {
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  InvalidToolOutputError,
  type ProviderToolCall,
} from '../types.js';

/**
 * Build the fetch_url backend descriptor from env. Returns null if
 * neither internal (scrapling-fetcher) nor external (gatewaze-fetch
 * public-API) credentials are configured.
 */
function buildFetchOptions(): FetchUrlOptions | null {
  if (canvasAiConfig.scraplingFetcherUrl && canvasAiConfig.scraplingInternalToken) {
    return {
      backend: 'scrapling',
      baseUrl: canvasAiConfig.scraplingFetcherUrl,
      internalToken: canvasAiConfig.scraplingInternalToken,
      mode: canvasAiConfig.scraplingFetcherMode,
      maxBytes: canvasAiConfig.fetchUrlMaxBytes,
      timeoutMs: canvasAiConfig.fetchUrlTimeoutMs,
    };
  }
  if (canvasAiConfig.gatewazeFetchBaseUrl && canvasAiConfig.gatewazeFetchApiKey) {
    return {
      backend: 'gatewaze-fetch',
      baseUrl: canvasAiConfig.gatewazeFetchBaseUrl,
      apiKey: canvasAiConfig.gatewazeFetchApiKey,
      tenantId: canvasAiConfig.gatewazeFetchTenantId,
      maxBytes: canvasAiConfig.fetchUrlMaxBytes,
      timeoutMs: canvasAiConfig.fetchUrlTimeoutMs,
    };
  }
  return null;
}

export interface DispatchToolCallArgs {
  systemPrompt: string;
  userPrompt: string;
  toolName: string;
  toolDescription?: string;
  toolInputSchema: Record<string, unknown>;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Supabase service-role client. Used for ai_usage_events writes. */
  supabase: SupabaseLikeRpc;
  /** Per-request provider override. Forwarded to runChat. */
  providerOverride?: 'anthropic' | 'openai' | 'auto';
  /** Per-request model override. Forwarded to runChat. */
  modelOverride?: string;
  /** Used to attribute fetch_url + web_search calls in ai_usage_events. */
  userId?: string;
}

export interface DispatchToolCallResult extends ProviderToolCall {
  webSearches: ReadonlyArray<WebSearchAuditEntry>;
  fetchedUrls: ReadonlyArray<FetchedUrlAuditEntry>;
  providerName: 'anthropic' | 'openai' | 'gemini';
}

/** Structural shape of the AI module's runChat — dynamic-loaded so
 *  the editor's TypeScript compilation doesn't bind to the AI module's
 *  internal types at build time. Same defensive pattern as quota.ts. */
interface AiRunnerModule {
  runChat: (
    ctx: { supabase: unknown; resolveFetchUrl?: (url: string, reason: string) => Promise<{ ok: boolean; content: string; bytesIn: number; finalUrl: string; error?: string }> },
    opts: Record<string, unknown>,
  ) => Promise<{
    narrative: string;
    structured: Record<string, unknown> | null;
    provider: 'anthropic' | 'openai' | 'gemini';
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
    costMicroUsd: number;
    latencyMs: number;
    fetchedUrls: Array<unknown>;
    webSearchCount: number;
  }>;
}

let cachedAiRunner: AiRunnerModule | null | undefined;
async function loadRunChat(): Promise<AiRunnerModule['runChat']> {
  if (cachedAiRunner !== undefined && cachedAiRunner !== null) return cachedAiRunner.runChat;
  const attempts = [
    '@gatewaze-modules/ai/lib/runner.js',
    '../../../../../gatewaze-modules/modules/ai/lib/runner.ts',
  ];
  for (const path of attempts) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = (await import(path as any)) as AiRunnerModule;
      if (typeof mod.runChat === 'function') {
        cachedAiRunner = mod;
        return mod.runChat;
      }
    } catch {
      // try the next path
    }
  }
  cachedAiRunner = null;
  throw new Error('@gatewaze-modules/ai runChat unavailable — required for editor-ai-copilot');
}

export async function dispatchToolCall(
  args: DispatchToolCallArgs,
): Promise<DispatchToolCallResult> {
  // Quota / cost gates — same per-tool decision points as before so
  // the editor's hard-cap behaviour is unchanged.
  const fetchUrlUsage = await readTodayUsage(args.supabase, 'fetch_url');
  const webSearchUsage = await readTodayUsage(args.supabase, 'web_search');
  const combinedCostMicroUsd = fetchUrlUsage.costMicroUsd + webSearchUsage.costMicroUsd;
  const fetchOptions = canvasAiConfig.fetchUrlEnabled ? buildFetchOptions() : null;

  const fetchGated = fetchOptions
    ? shouldAllowToolCall(
        fetchUrlUsage,
        {
          dailyMaxCalls: canvasAiConfig.fetchUrlDailyMax,
          dailyCostBudgetMicroUsd: canvasAiConfig.dailyToolCostBudgetMicroUsd,
        },
        combinedCostMicroUsd,
        canvasAiConfig.fetchUrlCostMicroUsd,
      )
    : { ok: false as const, reason: 'fetch_url_disabled' };
  const webSearchGated = canvasAiConfig.webSearchEnabled
    ? shouldAllowToolCall(
        webSearchUsage,
        {
          dailyMaxCalls: canvasAiConfig.webSearchDailyMax,
          dailyCostBudgetMicroUsd: canvasAiConfig.dailyToolCostBudgetMicroUsd,
        },
        combinedCostMicroUsd,
        canvasAiConfig.webSearchCostMicroUsd,
      )
    : { ok: false as const, reason: 'web_search_disabled' };

  const fetchedUrls: FetchedUrlAuditEntry[] = [];

  // Web-tools wiring: the AI module's runChat calls resolveFetchUrl
  // per tool-use; we wrap it to bump the editor's per-call ledger.
  const resolveFetchUrl = fetchGated.ok && fetchOptions
    ? async (url: string, reason: string) => {
        const started = Date.now();
        const r = await fetchViaGatewazeFetch(url, fetchOptions);
        const entry: FetchedUrlAuditEntry = r.ok
          ? {
              url,
              reason,
              status: 200,
              byte_count: r.bytes,
              mode: r.mode,
              fetched_at: new Date(started).toISOString(),
              source: 'gatewaze-fetch',
              error_code: null,
            }
          : {
              url,
              reason,
              status: 0,
              byte_count: 0,
              mode: 'error',
              fetched_at: new Date(started).toISOString(),
              source: 'gatewaze-fetch',
              error_code: r.errorCode,
            };
        fetchedUrls.push(entry);
        if (entry.error_code === null) {
          void bumpTodayUsage(args.supabase, 'fetch_url', 1, canvasAiConfig.fetchUrlCostMicroUsd);
        }
        return {
          ok: r.ok,
          content: r.ok ? r.text : (r.errorMessage ?? ''),
          bytesIn: r.ok ? r.bytes : 0,
          finalUrl: r.ok ? r.final_url : url,
          ...(r.ok ? {} : { error: r.errorMessage }),
        };
      }
    : undefined;

  const allowedWebTools: Array<'web_search' | 'fetch_url'> = [];
  if (webSearchGated.ok) allowedWebTools.push('web_search');
  if (resolveFetchUrl) allowedWebTools.push('fetch_url');

  const systemPrompt = allowedWebTools.length > 0
    ? buildSystemPromptWithWebTools(args.systemPrompt)
    : args.systemPrompt;

  const runChat = await loadRunChat();
  const ctx = {
    supabase: args.supabase as unknown as Parameters<typeof runChat>[0]['supabase'],
    ...(resolveFetchUrl ? { resolveFetchUrl } : {}),
  };

  const started = Date.now();
  let result;
  try {
    result = await runChat(ctx, {
      useCase: 'editor-ai-copilot',
      userId: args.userId ?? null,
      threadId: null,
      messageId: null,
      systemPrompt,
      messages: [{ role: 'user', content: args.userPrompt }],
      structuredTool: {
        name: args.toolName,
        description: args.toolDescription ?? 'Emit the final structured output described by inputSchema.',
        inputSchema: args.toolInputSchema,
      },
      ...(args.providerOverride && args.providerOverride !== 'auto' ? { provider: args.providerOverride } : {}),
      ...(args.modelOverride ? { model: args.modelOverride } : {}),
      maxOutputTokens: args.maxOutputTokens,
      timeoutMs: args.timeoutMs,
    });
  } catch (err) {
    throw translateRunChatError(err);
  }

  if (!result.structured) {
    throw new InvalidToolOutputError(
      `model did not invoke the structured tool '${args.toolName}'`,
    );
  }

  // web_search audit synthesis. runChat returns only a count via
  // webSearchCount; per-query detail isn't surfaced. Construct one
  // synthetic entry per billed call so the editor's existing
  // audit-row contract is preserved.
  const webSearches: WebSearchAuditEntry[] = [];
  for (let i = 0; i < result.webSearchCount; i++) {
    webSearches.push({
      query: '(routed via @gatewaze-modules/ai)',
      result_count: 0,
      billed: true,
    });
  }
  if (result.webSearchCount > 0) {
    void bumpTodayUsage(
      args.supabase,
      'web_search',
      result.webSearchCount,
      result.webSearchCount * canvasAiConfig.webSearchCostMicroUsd,
    );
  }

  return {
    input: result.structured,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: Date.now() - started,
    model: result.model,
    webSearches,
    fetchedUrls,
    providerName: result.provider,
  };
}

/**
 * Map @gatewaze-modules/ai's ProviderError shape onto the editor's
 * pre-existing ProviderError / RateLimit / Timeout classes so the
 * caller in generate.ts doesn't need to know about both type systems.
 */
function translateRunChatError(err: unknown): Error {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  if (!e || typeof e !== 'object') {
    return err instanceof Error ? err : new Error(String(err));
  }
  if (e.name === 'ProviderTimeoutError') {
    return new ProviderTimeoutError(
      (e.provider === 'openai' ? 'openai' : 'anthropic') as 'anthropic' | 'openai',
    );
  }
  if (e.name === 'ProviderRateLimitError') {
    return new ProviderRateLimitError(
      typeof e.retryAfterSeconds === 'number' ? e.retryAfterSeconds : null,
      (e.provider === 'openai' ? 'openai' : 'anthropic') as 'anthropic' | 'openai',
    );
  }
  if (e.name === 'ProviderError') {
    return new ProviderError(
      typeof e.message === 'string' ? e.message : 'provider error',
      typeof e.httpStatus === 'number' ? e.httpStatus : 502,
      (e.provider === 'openai' ? 'openai' : 'anthropic') as 'anthropic' | 'openai',
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
