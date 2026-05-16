/**
 * OpenAI provider client.
 *
 * Supports:
 *   - runConversation: chat completions with optional tool-use loop for
 *     structured-output. OpenAI doesn't have server-side web_search;
 *     fetch_url is dispatched via the runner's resolveFetchUrl callback
 *     the same way Anthropic does.
 *   - generateEmbedding: text-embedding-3-small / large via embeddings API.
 *   - generateImage: gpt-image-1 via images API.
 */

import OpenAI from 'openai';
import {
  type ConversationMessage,
  type FetchedUrlAudit,
  type GenerateEmbeddingOpts,
  type GenerateEmbeddingResult,
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

export class OpenAIProviderClient implements ProviderClient {
  readonly provider = 'openai' as const;
  private readonly client: OpenAI;

  constructor(apiKey: string, baseUrl?: string) {
    this.client = new OpenAI({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
  }

  capabilities() {
    return {
      streaming: true,
      tools: true,
      web_search: false,
      image_gen: true,
      embeddings: true,
    };
  }

  async runConversation(opts: RunConversationOpts): Promise<RunConversationResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

    const tools = buildTools(opts);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: opts.systemPrompt },
      ...opts.messages.map(toOpenAIMessage),
    ];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;
    let lastModel = opts.model;
    const fetchedUrls: FetchedUrlAudit[] = [];
    let fetchCallsThisTurn = 0;

    try {
      for (let iter = 0; iter < MAX_LOOP_ITERATIONS; iter++) {
        let response: OpenAI.Chat.ChatCompletion;
        try {
          response = await this.client.chat.completions.create(
            {
              model: opts.model,
              max_tokens: opts.maxOutputTokens,
              messages,
              tools: tools as OpenAI.Chat.ChatCompletionTool[],
              tool_choice: opts.structuredTool ? 'auto' : 'auto',
            },
            { signal: controller.signal },
          );
        } catch (err) {
          if (controller.signal.aborted) throw new ProviderTimeoutError('openai');
          throw mapOpenAIError(err);
        }

        lastModel = response.model ?? opts.model;
        totalInputTokens += response.usage?.prompt_tokens ?? 0;
        totalOutputTokens += response.usage?.completion_tokens ?? 0;
        const usageDetails = (response.usage as unknown as
          | { prompt_tokens_details?: { cached_tokens?: number } }
          | undefined)?.prompt_tokens_details;
        if (typeof usageDetails?.cached_tokens === 'number') {
          totalCachedTokens += usageDetails.cached_tokens;
        }

        const choice = response.choices[0];
        if (!choice) {
          throw new InvalidProviderOutputError('no choices in response', 'openai');
        }

        const toolCalls = choice.message.tool_calls ?? [];

        // ── Structured-output hit?
        if (opts.structuredTool) {
          const hit = toolCalls.find((c) => c.function?.name === opts.structuredTool!.name);
          if (hit) {
            let input: Record<string, unknown>;
            try {
              input = JSON.parse(hit.function.arguments) as Record<string, unknown>;
            } catch (err) {
              throw new InvalidProviderOutputError(
                `structured tool arguments were not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
                'openai',
              );
            }
            return {
              narrative: choice.message.content ?? '',
              structured: input,
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              cachedTokens: totalCachedTokens,
              durationMs: Date.now() - started,
              model: lastModel,
              fetchedUrls,
              webSearchCount: 0,
            };
          }
        } else if (choice.finish_reason === 'stop') {
          return {
            narrative: choice.message.content ?? '',
            structured: null,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cachedTokens: totalCachedTokens,
            durationMs: Date.now() - started,
            model: lastModel,
            fetchedUrls,
            webSearchCount: 0,
          };
        }

        // ── fetch_url tool calls?
        const fetchCalls = toolCalls.filter((c) => c.function?.name === 'fetch_url');
        if (fetchCalls.length === 0) {
          throw new InvalidProviderOutputError(
            `model stopped (finish_reason=${choice.finish_reason}) without emitting the structured tool`,
            'openai',
          );
        }

        const toolMessages: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];
        for (const call of fetchCalls) {
          let parsed: { url?: string; reason?: string };
          try {
            parsed = JSON.parse(call.function.arguments) as { url?: string; reason?: string };
          } catch {
            parsed = {};
          }
          const url = typeof parsed.url === 'string' ? parsed.url : '';
          const reason = typeof parsed.reason === 'string' ? parsed.reason : '';

          if (!opts.resolveFetchUrl) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: '[fetch_url_disabled] fetch_url is not enabled for this use-case.',
            });
            continue;
          }
          fetchCallsThisTurn++;
          if (fetchCallsThisTurn > (opts.fetchUrlMaxPerTurn ?? 8)) {
            toolMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: '[fetch_quota_exceeded] per-turn fetch limit reached.',
            });
            continue;
          }

          const result = await opts.resolveFetchUrl(url, reason);
          fetchedUrls.push({
            url,
            status: result.ok ? 200 : 0,
            bytes_in: result.bytesIn,
            reason,
            fetched_at: new Date().toISOString(),
          });
          toolMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result.ok ? result.content : `[fetch_error] ${result.error ?? 'unknown'}`,
          });
        }

        messages.push({
          role: 'assistant',
          content: choice.message.content,
          tool_calls: toolCalls,
        });
        messages.push(...toolMessages);
      }

      throw new InvalidProviderOutputError(
        `tool loop exceeded MAX_LOOP_ITERATIONS=${MAX_LOOP_ITERATIONS}`,
        'openai',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async generateEmbedding(opts: GenerateEmbeddingOpts): Promise<GenerateEmbeddingResult> {
    try {
      const response = await this.client.embeddings.create({
        model: opts.model,
        input: opts.texts,
      });
      return {
        vectors: response.data.map((d) => d.embedding),
        inputTokens: response.usage?.prompt_tokens ?? 0,
        model: opts.model,
      };
    } catch (err) {
      throw mapOpenAIError(err);
    }
  }

  async generateImage(opts: GenerateImageOpts): Promise<GenerateImageResult> {
    const size = aspectRatioToSize(opts.aspectRatio);
    try {
      const response = await this.client.images.generate({
        model: opts.model,
        prompt: opts.prompt,
        n: 1,
        size,
        response_format: 'b64_json',
      });
      const b64 = response.data?.[0]?.b64_json;
      if (!b64) {
        throw new InvalidProviderOutputError(
          'image API returned no b64_json',
          'openai',
        );
      }
      return {
        imageBytes: Buffer.from(b64, 'base64'),
        mimeType: 'image/png',
        prompt: opts.prompt,
      };
    } catch (err) {
      if (err instanceof InvalidProviderOutputError) throw err;
      throw mapOpenAIError(err);
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildTools(opts: RunConversationOpts): unknown[] {
  const out: unknown[] = [];
  if (opts.structuredTool) {
    out.push({
      type: 'function',
      function: {
        name: opts.structuredTool.name,
        description: opts.structuredTool.description,
        parameters: opts.structuredTool.inputSchema,
        strict: true,
      },
    });
  }
  if (opts.webTools?.includes('fetch_url')) {
    out.push({
      type: 'function',
      function: {
        name: 'fetch_url',
        description: 'Fetch the contents of a public URL.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Absolute https:// URL.' },
            reason: { type: 'string', description: 'Short reason for the fetch.' },
          },
          required: ['url', 'reason'],
        },
        strict: false,
      },
    });
  }
  // web_search is not supported by OpenAI (as of 2026-05). Skip silently.
  return out;
}

function toOpenAIMessage(m: ConversationMessage): OpenAI.Chat.ChatCompletionMessageParam {
  switch (m.role) {
    case 'system':
      return { role: 'system', content: m.content };
    case 'user':
      return { role: 'user', content: m.content };
    case 'assistant':
      return { role: 'assistant', content: m.content };
    case 'tool_result':
      // Synthetic; the OpenAI loop above produces real tool messages itself.
      return { role: 'user', content: m.content };
  }
}

function aspectRatioToSize(
  ratio: GenerateImageOpts['aspectRatio'],
): '1024x1024' | '1536x1024' | '1024x1536' | '1024x768' {
  switch (ratio) {
    case '16:9':
      return '1536x1024';
    case '9:16':
      return '1024x1536';
    case '4:3':
      return '1024x768';
    case '1:1':
    default:
      return '1024x1024';
  }
}

function mapOpenAIError(err: unknown): ProviderError {
  const status = (err as { status?: number } | null)?.status ?? 0;
  if (status === 429) {
    const headers = (err as { headers?: Record<string, string> } | null)?.headers;
    const retryAfter = parseRetryAfter(headers);
    return new ProviderRateLimitError('openai', retryAfter);
  }
  return new ProviderError(
    err instanceof Error ? err.message : String(err),
    'openai',
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
