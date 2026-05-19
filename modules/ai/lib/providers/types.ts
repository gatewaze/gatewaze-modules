/**
 * Provider abstraction layer.
 *
 * Each provider (OpenAI, Anthropic, Gemini) implements `ProviderClient`.
 * The provider router (router.ts) resolves the right client + API key
 * for a (use_case, user, provider, model) tuple, and the runner calls
 * `runConversation()` / `generateEmbedding()` / `generateImage()` on it.
 *
 * The interface is intentionally narrow: callers only see the operations
 * they need, and providers can implement them with their native SDK
 * surface. Adding a new provider is a single new file plus a router
 * registration.
 */

export type KnownProvider = 'openai' | 'anthropic' | 'gemini';
/**
 * `web_search`     — the provider's native web search (Anthropic web_search,
 *                    Gemini googleSearch, etc.). Quality varies; some are
 *                    billed (Anthropic = $10/1k calls).
 * `fetch_url`      — retrieve a specific URL via gatewaze-fetch.
 * `gatewaze_search` — provider-agnostic web search backed by Serper.dev or
 *                    a DuckDuckGo HTML scrape (via scrapling-fetcher). Free
 *                    when DDG, ~$1/1k when Serper. Exposed as a function-
 *                    call tool so every model sees the same surface.
 */
export type WebTool = 'web_search' | 'fetch_url' | 'gatewaze_search';

export interface GatewazeSearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ─── Conversation (multi-turn chat with optional tool use) ────────────────

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool_result';
  /** Plain-text content; tool messages serialise their JSON into this. */
  content: string;
}

export interface StructuredOutputTool {
  /** Tool name the model calls to terminate its turn. */
  name: string;
  description: string;
  /** JSON-Schema object describing the input the tool accepts. */
  inputSchema: Record<string, unknown>;
}

/**
 * A tool function the provider should expose to the model alongside
 * the built-in web tools (web_search, fetch_url, gatewaze_search) and
 * the optional structured-output tool. Used for MCP-server tools +
 * the `builtin: memory` surface in recipe execution.
 *
 * Naming convention: dotted names (e.g. `memory.store`, `github.get_pr`)
 * are recommended so the model can pattern-match category from name.
 * The provider doesn't constrain the name shape beyond what each SDK
 * requires.
 */
export interface ExtraTool {
  name: string;
  description: string;
  /** JSON-Schema input descriptor — exactly what each provider's tool API expects. */
  inputSchema: Record<string, unknown>;
  /**
   * Resolver invoked by the provider when the model calls this tool.
   * Return value is JSON-stringified into the tool_result block.
   * Resolver-thrown errors are caught by the provider and surfaced
   * to the model as `{ error: "..." }`.
   */
  resolve: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface RunConversationOpts {
  systemPrompt: string;
  messages: ConversationMessage[];

  /** When set, the model MUST terminate via this tool — output is its `input` field. */
  structuredTool?: StructuredOutputTool;

  /** Permitted web tools. Empty array = none. */
  webTools?: WebTool[];

  /** Max tokens to emit. Enforced server-side by the provider. */
  maxOutputTokens: number;
  /** Wall-clock cap (ms) on the whole loop, including tool round-trips. */
  timeoutMs: number;

  /** Resolved model id. */
  model: string;

  /** Per-turn caps for tool calls. */
  webSearchMaxPerTurn?: number;
  fetchUrlMaxPerTurn?: number;
  /** Cap on internal gatewaze_search calls per turn. */
  gatewazeSearchMaxPerTurn?: number;

  /**
   * Resolves a fetch_url invocation. The runner provides this so the
   * caller's attribution can be threaded through to gatewaze-fetch.
   */
  resolveFetchUrl?: (url: string, reason: string) => Promise<{
    ok: boolean;
    content: string;   // truncated, wrapped for the model
    bytesIn: number;
    finalUrl: string;
    error?: string;
  }>;

  /**
   * Extra tools the provider should expose to the model alongside the
   * built-in web tools. Used by the recipe runner to inject MCP
   * `streamable_http` tools and the `builtin: memory` surface.
   *
   * The resolver is a thunk the provider calls when the model invokes
   * the tool; the returned value is JSON-stringified and fed back as
   * the tool_result block (or function-response, depending on
   * provider). Errors thrown by the resolver should be caught by the
   * provider and surfaced to the model as a `{ error: "..." }` payload
   * so the model can decide whether to recover or give up.
   *
   * Provider parity caveat: as of this commit, only anthropic-client
   * wires extraTools through. openai-client and gemini-client accept
   * the parameter but ignore it — recipes that rely on extraTools
   * MUST set settings.goose_provider: anthropic until that lands.
   */
  extraTools?: ExtraTool[];

  /**
   * Resolves a gatewaze_search invocation. The runner provides this so
   * the underlying backend (Serper, DDG, etc.) can be swapped without
   * changing the provider implementations. Returns the top N results
   * for the query.
   */
  resolveGatewazeSearch?: (query: string, maxResults: number) => Promise<{
    ok: boolean;
    results: GatewazeSearchResult[];
    backend: 'serper' | 'ddg';
    error?: string;
  }>;
}

export interface FetchedUrlAudit {
  url: string;
  status: number;
  bytes_in: number;
  reason: string;
  fetched_at: string;
}

export interface RunConversationResult {
  /** Plain narrative output (assistant's text turn). */
  narrative: string;
  /** Structured-output JSON when `structuredTool` was set; null otherwise. */
  structured: Record<string, unknown> | null;

  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /**
   * Anthropic cache-creation tokens (the 1.25× premium tier). Only
   * populated by the anthropic provider; openai/gemini return 0.
   */
  cacheCreationTokens: number;

  durationMs: number;
  model: string;        // echo of the resolved model id

  fetchedUrls: FetchedUrlAudit[];
  webSearchCount: number;
  /** Count of gatewaze_search invocations during the turn. */
  gatewazeSearchCount: number;
}

// ─── Embeddings ────────────────────────────────────────────────────────────

export interface GenerateEmbeddingOpts {
  texts: string[];
  model: string;
}

export interface GenerateEmbeddingResult {
  vectors: number[][];
  inputTokens: number;
  model: string;
}

// ─── Image generation ──────────────────────────────────────────────────────

export interface GenerateImageOpts {
  prompt: string;
  model: string;
  aspectRatio?: '16:9' | '1:1' | '4:3' | '9:16';
  /**
   * Reference images sent to the provider as visual conditioning.
   * Providers that support image inputs (currently Gemini 2.5 Flash
   * Image / "Nano Banana") prepend these as `inlineData` parts before
   * the text prompt. Providers that don't ignore the field.
   */
  referenceImages?: Array<{ mimeType: string; base64: string }>;
}

export interface GenerateImageResult {
  /** Raw PNG bytes (caller uploads to storage). */
  imageBytes: Buffer;
  mimeType: string;
  prompt: string;       // echoed back for audit (some providers prepend safety wrappers)
}

// ─── Client interface ──────────────────────────────────────────────────────

export interface ProviderClient {
  provider: KnownProvider;

  capabilities(): {
    streaming: boolean;
    tools: boolean;
    web_search: boolean;
    image_gen: boolean;
    embeddings: boolean;
  };

  runConversation?(opts: RunConversationOpts): Promise<RunConversationResult>;
  generateEmbedding?(opts: GenerateEmbeddingOpts): Promise<GenerateEmbeddingResult>;
  generateImage?(opts: GenerateImageOpts): Promise<GenerateImageResult>;
}

// ─── Error types ───────────────────────────────────────────────────────────

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: KnownProvider | 'unknown',
    public readonly httpStatus = 0,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class ProviderRateLimitError extends ProviderError {
  constructor(provider: KnownProvider, public readonly retryAfterMs: number | null) {
    super(`${provider} rate-limited`, provider, 429, true);
    this.name = 'ProviderRateLimitError';
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(provider: KnownProvider) {
    super(`${provider} request timed out`, provider, 0, true);
    this.name = 'ProviderTimeoutError';
  }
}

export class InvalidProviderOutputError extends Error {
  constructor(message: string, public readonly provider: KnownProvider) {
    super(message);
    this.name = 'InvalidProviderOutputError';
  }
}

export class NoCredentialsError extends Error {
  constructor(public readonly provider: KnownProvider) {
    super(`No credentials configured for provider '${provider}'`);
    this.name = 'NoCredentialsError';
  }
}
