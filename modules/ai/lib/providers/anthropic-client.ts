/**
 * Anthropic provider client.
 *
 * Conversational loop with `web_search` (server-side tool, Anthropic-
 * hosted) + `fetch_url` (user tool, dispatched to gatewaze-fetch via
 * the runner's `resolveFetchUrl` callback). Terminates when the model
 * emits the structured-output tool by name, or on `end_turn` for plain
 * narrative use-cases that don't supply one.
 *
 * Adapted from editor-ai-copilot/lib/web-tools/anthropic-loop.ts —
 * stripped of editor-specific quota gates (those live in the runner now)
 * and refactored against the generic ProviderClient interface.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  type ConversationMessage,
  type FetchedUrlAudit,
  type GenerateImageOpts,
  type GenerateImageResult,
  InvalidProviderOutputError,
  type ProviderClient,
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  type RunConversationOpts,
  type RunConversationResult,
} from './types.js';

const MAX_LOOP_ITERATIONS = 12;

export class AnthropicProviderClient implements ProviderClient {
  readonly provider = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(apiKey: string, baseUrl?: string) {
    this.client = new Anthropic({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
  }

  capabilities() {
    return {
      streaming: true,
      tools: true,
      web_search: true,
      image_gen: false,
      embeddings: false,
    };
  }

  async runConversation(opts: RunConversationOpts): Promise<RunConversationResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

    const tools = buildTools(opts);

    let messages: Anthropic.MessageParam[] = toAnthropicMessages(opts.messages);
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;
    let lastModel = opts.model;
    const fetchedUrls: FetchedUrlAudit[] = [];
    let webSearchCount = 0;
    let fetchCallsThisTurn = 0;

    try {
      for (let iter = 0; iter < MAX_LOOP_ITERATIONS; iter++) {
        let response: Anthropic.Message;
        try {
          response = await this.client.messages.create(
            {
              model: opts.model,
              max_tokens: opts.maxOutputTokens,
              system: opts.systemPrompt,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              tools: tools as any,
              tool_choice: { type: 'auto' },
              messages,
            },
            { signal: controller.signal },
          );
        } catch (err) {
          if (controller.signal.aborted) throw new ProviderTimeoutError('anthropic');
          throw mapAnthropicError(err);
        }

        lastModel = response.model ?? opts.model;
        totalInputTokens += response.usage?.input_tokens ?? 0;
        totalOutputTokens += response.usage?.output_tokens ?? 0;
        const usageRaw = (response.usage ?? {}) as unknown as Record<string, unknown>;
        const cached = usageRaw['cache_read_input_tokens'];
        if (typeof cached === 'number') totalCachedTokens += cached;
        const serverToolUse = usageRaw['server_tool_use'] as
          | { web_search_requests?: number }
          | undefined;
        if (typeof serverToolUse?.web_search_requests === 'number') {
          webSearchCount = serverToolUse.web_search_requests;
        }

        const contentBlocks = response.content as unknown as Array<
          Record<string, unknown>
        >;

        // ── Structured-output tool? Return immediately.
        if (opts.structuredTool) {
          const hit = contentBlocks.find(
            (b) => b['type'] === 'tool_use' && b['name'] === opts.structuredTool!.name,
          );
          if (hit) {
            const input = hit['input'];
            if (input == null || typeof input !== 'object') {
              throw new InvalidProviderOutputError(
                'structured tool_use missing input',
                'anthropic',
              );
            }
            return {
              narrative: extractNarrative(contentBlocks),
              structured: input as Record<string, unknown>,
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              cachedTokens: totalCachedTokens,
              durationMs: Date.now() - started,
              model: lastModel,
              fetchedUrls,
              webSearchCount,
            };
          }
        } else if (response.stop_reason === 'end_turn') {
          // Plain narrative path: return the text.
          return {
            narrative: extractNarrative(contentBlocks),
            structured: null,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cachedTokens: totalCachedTokens,
            durationMs: Date.now() - started,
            model: lastModel,
            fetchedUrls,
            webSearchCount,
          };
        }

        // ── No structured hit yet; must be a fetch_url tool call.
        const toolUseBlocks = contentBlocks.filter(
          (b) => b['type'] === 'tool_use' && b['name'] === 'fetch_url',
        );
        if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
          throw new InvalidProviderOutputError(
            `model stopped (stop_reason=${response.stop_reason}) without emitting the structured tool`,
            'anthropic',
          );
        }

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of toolUseBlocks) {
          const toolUseId = String(block['id'] ?? '');
          const input = block['input'] as { url?: string; reason?: string } | undefined;
          const url = typeof input?.url === 'string' ? input.url : '';
          const reason = typeof input?.reason === 'string' ? input.reason : '';

          if (!opts.resolveFetchUrl) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: '[fetch_url_disabled] fetch_url is not enabled for this use-case.',
              is_error: true,
            });
            continue;
          }
          fetchCallsThisTurn++;
          if (fetchCallsThisTurn > (opts.fetchUrlMaxPerTurn ?? 8)) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: '[fetch_quota_exceeded] per-turn fetch limit reached.',
              is_error: true,
            });
            continue;
          }

          const fetchResult = await opts.resolveFetchUrl(url, reason);
          fetchedUrls.push({
            url,
            status: fetchResult.ok ? 200 : 0,
            bytes_in: fetchResult.bytesIn,
            reason,
            fetched_at: new Date().toISOString(),
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: fetchResult.ok
              ? fetchResult.content
              : `[fetch_error] ${fetchResult.error ?? 'unknown'}`,
            is_error: !fetchResult.ok,
          });
        }

        messages = [
          ...messages,
          { role: 'assistant', content: response.content as Anthropic.ContentBlock[] },
          { role: 'user', content: toolResults },
        ];
      }

      throw new InvalidProviderOutputError(
        `web-tools loop exceeded MAX_LOOP_ITERATIONS=${MAX_LOOP_ITERATIONS} without emitting the structured tool`,
        'anthropic',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async generateImage(_opts: GenerateImageOpts): Promise<GenerateImageResult> {
    throw new ProviderError(
      'Anthropic does not provide image generation; route via Gemini or OpenAI.',
      'anthropic',
    );
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildTools(opts: RunConversationOpts): unknown[] {
  const out: unknown[] = [];
  if (opts.structuredTool) {
    out.push({
      name: opts.structuredTool.name,
      description: opts.structuredTool.description,
      input_schema: opts.structuredTool.inputSchema,
    });
  }
  if (opts.webTools?.includes('web_search')) {
    out.push({
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: opts.webSearchMaxPerTurn ?? 6,
    });
  }
  if (opts.webTools?.includes('fetch_url')) {
    out.push({
      name: 'fetch_url',
      description:
        'Fetch the contents of a public URL. Use this to read primary sources discovered via web_search.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute https:// URL.' },
          reason: {
            type: 'string',
            description: 'Short description of why this URL is being fetched.',
          },
        },
        required: ['url', 'reason'],
      },
    });
  }
  return out;
}

function toAnthropicMessages(
  messages: ConversationMessage[],
): Anthropic.MessageParam[] {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m): Anthropic.MessageParam => {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      return { role, content: m.content };
    });
}

function extractNarrative(blocks: Array<Record<string, unknown>>): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b['type'] === 'text' && typeof b['text'] === 'string') {
      out.push(b['text'] as string);
    }
  }
  return out.join('\n').trim();
}

function mapAnthropicError(err: unknown): ProviderError {
  const status = (err as { status?: number } | null)?.status ?? 0;
  if (status === 429) {
    const headers = (err as { headers?: Record<string, string> } | null)?.headers;
    const retryAfter = parseRetryAfter(headers);
    return new ProviderRateLimitError('anthropic', retryAfter);
  }
  return new ProviderError(
    err instanceof Error ? err.message : String(err),
    'anthropic',
    status,
    status >= 500,
  );
}

function parseRetryAfter(headers: Record<string, string> | undefined): number | null {
  if (!headers) return null;
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (!raw) return null;
  const sec = parseInt(raw, 10);
  return Number.isFinite(sec) ? sec * 1000 : null;
}
