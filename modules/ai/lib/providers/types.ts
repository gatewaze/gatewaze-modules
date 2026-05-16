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
export type WebTool = 'web_search' | 'fetch_url';

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

  durationMs: number;
  model: string;        // echo of the resolved model id

  fetchedUrls: FetchedUrlAudit[];
  webSearchCount: number;
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
