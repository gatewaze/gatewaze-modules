/**
 * Shared types for editor-ai-copilot. Keep these flat + minimal —
 * deeper types (e.g. PuckData itself) live in the consuming modules
 * (@gatewaze-modules/sites/admin/components/canvas/puck/types.ts).
 */

export type HostKind = 'site' | 'newsletter';

export type GenerateMode = 'replace' | 'append' | 'insert-after' | 'edit' | 'edit-block';

export type ProviderName = 'anthropic' | 'openai';

export type AuditStatus =
  | 'ok'
  | 'invalid_output'
  | 'provider_error'
  | 'timeout'
  | 'rate_limited'
  | 'validation_dropped_all'
  | 'no_blocks'
  | 'block_not_found';

/** Subset of templates_block_defs needed to construct the tool schema + validate output. */
export interface BlockDefView {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  /** JSON Schema (draft 2020-12) for the block's `props`. */
  schema: Record<string, unknown>;
  has_bricks: boolean;
  theme_kind: 'website' | 'email';
}

/** A Puck-data block entry (one of `data.content[]`). */
export interface PuckBlockEntry {
  type: string;
  props: { id: string; [k: string]: unknown };
}

export interface PuckData {
  content: ReadonlyArray<PuckBlockEntry>;
  root: { props: Record<string, unknown> };
}

/** Returned by HostAdapter.loadTarget — everything the AI request needs about the target. */
export interface HostLoadResult {
  data: PuckData;
  themeKind: 'website' | 'email';
  libraryId: string;
  pageTitle?: string;
  pagePath?: string;
}

/** Host-kind dispatcher — implementations live in sites + newsletters modules. */
export interface HostAdapter {
  loadTarget(args: {
    hostKind: HostKind;
    hostId: string;
    targetId: string;
  }): Promise<HostLoadResult>;
  /** Check the caller can admin this host. Optional — falls back to per-route assertCanAdmin. */
  assertCanAdmin?(args: {
    userId: string;
    hostId: string;
  }): Promise<{ ok: true } | { ok: false; httpStatus: number; code: string; message: string }>;
}

/** Provider client contract — small surface to swap Anthropic / OpenAI behind. */
export interface ProviderToolCall {
  /** Parsed JSON object the LLM emitted via the tool. */
  input: unknown;
  /** Token accounting (best-effort; may be 0 if the provider didn't report). */
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock duration of the LLM call in ms. */
  durationMs: number;
  /** The actual model id used (echoed back). */
  model: string;
}

export interface ProviderClient {
  name: ProviderName;
  /**
   * Single tool-use call. The client wraps timeout + one-shot
   * retry-on-invalid-JSON internally. Throws ProviderError on
   * upstream 5xx, RateLimitError on upstream 429, TimeoutError on
   * wall-clock breach.
   */
  callTool(args: {
    systemPrompt: string;
    userPrompt: string;
    toolName: string;
    toolInputSchema: Record<string, unknown>;
    maxOutputTokens: number;
    timeoutMs: number;
  }): Promise<ProviderToolCall>;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly upstreamStatus: number, public readonly provider: ProviderName) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class ProviderRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number | null, public readonly provider: ProviderName) {
    super('provider rate limited');
    this.name = 'ProviderRateLimitError';
  }
}

export class ProviderTimeoutError extends Error {
  constructor(public readonly provider: ProviderName) {
    super('provider timeout');
    this.name = 'ProviderTimeoutError';
  }
}

export class InvalidToolOutputError extends Error {
  constructor(public readonly reason: string) {
    super(`invalid tool output: ${reason}`);
    this.name = 'InvalidToolOutputError';
  }
}
