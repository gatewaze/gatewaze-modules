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
 *
 * Recipe-injected `extraTools` (MCP servers, builtin: memory) are
 * honoured: each is declared as a chat.completions function and its
 * tool_calls are dispatched through the provided resolver. Strict-
 * mode is off for these because MCP schemas don't always fit OpenAI's
 * strict-mode subset.
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
    let gatewazeSearchCallsThisTurn = 0;
    let gatewazeSearchCount = 0;

    try {
      for (let iter = 0; iter < MAX_LOOP_ITERATIONS; iter++) {
        let response: OpenAI.Chat.ChatCompletion;
        try {
          // Reasoning models (o1/o3/o4/gpt-5) reject `max_tokens` and
          // require `max_completion_tokens` instead. The OpenAI SDK
          // types accept both, so we pick the param at request time.
          const tokensParam = isReasoningModel(opts.model)
            ? { max_completion_tokens: opts.maxOutputTokens }
            : { max_tokens: opts.maxOutputTokens };
          if (opts.onToken) {
            // Streaming path — iterate chunks, emit text deltas via the
            // supplied callback, then assemble a synthetic
            // ChatCompletion for the downstream loop logic. Spec-ai-
            // job-runner §4.2.
            //
            // `stream: true` switches the return type to an
            // AsyncIterable<ChatCompletionChunk>. We aggregate tool_call
            // fragments + text deltas into the same shape the non-
            // streaming variant returns.
            const stream = await this.client.chat.completions.create(
              {
                model: opts.model,
                ...tokensParam,
                messages,
                tools: tools as OpenAI.Chat.ChatCompletionTool[],
                tool_choice: opts.structuredTool ? 'auto' : 'auto',
                stream: true,
                stream_options: { include_usage: true },
              },
              { signal: controller.signal },
            );
            response = await assembleOpenAIChunks(
              stream as unknown as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
              opts.onToken,
              opts.model,
            );
          } else {
            response = await this.client.chat.completions.create(
              {
                model: opts.model,
                ...tokensParam,
                messages,
                tools: tools as OpenAI.Chat.ChatCompletionTool[],
                tool_choice: opts.structuredTool ? 'auto' : 'auto',
              },
              { signal: controller.signal },
            );
          }
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
              cacheCreationTokens: 0,
              durationMs: Date.now() - started,
              model: lastModel,
              fetchedUrls,
              webSearchCount: 0,
              gatewazeSearchCount,
            };
          }
        } else if (choice.finish_reason === 'stop') {
          return {
            narrative: choice.message.content ?? '',
            structured: null,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cachedTokens: totalCachedTokens,
            cacheCreationTokens: 0,
            durationMs: Date.now() - started,
            model: lastModel,
            fetchedUrls,
            webSearchCount: 0,
            gatewazeSearchCount,
          };
        }

        // ── Loop tool calls (fetch_url, gatewaze_search, extraTools).
        //    OpenAI has no native server-side web search via chat.
        //    completions, so web_search-style discovery happens via
        //    gatewaze_search. Recipe-injected extraTools (MCP servers,
        //    builtin: memory) land here too — recognised by name.
        const extraToolNames = new Set((opts.extraTools ?? []).map((t) => t.name));
        const handledCalls = toolCalls.filter(
          (c) =>
            c.function?.name === 'fetch_url' ||
            c.function?.name === 'gatewaze_search' ||
            extraToolNames.has(c.function?.name ?? ''),
        );
        if (handledCalls.length === 0) {
          throw new InvalidProviderOutputError(
            `model stopped (finish_reason=${choice.finish_reason}) without emitting the structured tool`,
            'openai',
          );
        }

        const toolMessages: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];
        for (const call of handledCalls) {
          if (call.function?.name === 'fetch_url') {
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
            continue;
          }

          if (call.function?.name === 'gatewaze_search') {
            let searchParsed: { query?: string; max_results?: number };
            try {
              searchParsed = JSON.parse(call.function.arguments) as {
                query?: string;
                max_results?: number;
              };
            } catch {
              searchParsed = {};
            }
            const query = typeof searchParsed.query === 'string' ? searchParsed.query : '';
            const requestedMax =
              typeof searchParsed.max_results === 'number' && searchParsed.max_results > 0
                ? searchParsed.max_results
                : 6;
            if (!opts.resolveGatewazeSearch) {
              toolMessages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: '[gatewaze_search_disabled] gatewaze_search is not enabled for this use-case.',
              });
              continue;
            }
            gatewazeSearchCallsThisTurn++;
            if (gatewazeSearchCallsThisTurn > (opts.gatewazeSearchMaxPerTurn ?? 6)) {
              toolMessages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: '[gatewaze_search_quota_exceeded] per-turn search limit reached.',
              });
              continue;
            }
            const searchResult = await opts.resolveGatewazeSearch(query, requestedMax);
            if (searchResult.ok) gatewazeSearchCount++;
            toolMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: searchResult.ok
                ? JSON.stringify({ backend: searchResult.backend, results: searchResult.results })
                : `[gatewaze_search_error] ${searchResult.error ?? 'unknown'}`,
            });
            continue;
          }

          // ── extraTools (recipe-injected: MCP servers, memory) ─────
          // Resolver-thrown errors are caught and surfaced to the
          // model as tool messages so it can decide whether to retry
          // with different args or give up the turn.
          const toolName = call.function?.name ?? '';
          const extra = (opts.extraTools ?? []).find((t) => t.name === toolName);
          if (extra) {
            let args: Record<string, unknown>;
            try {
              args = JSON.parse(call.function?.arguments ?? '{}') as Record<string, unknown>;
            } catch {
              args = {};
            }
            try {
              const result = await extra.resolve(args);
              toolMessages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: typeof result === 'string' ? result : JSON.stringify(result),
              });
            } catch (err) {
              toolMessages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: `[tool_error] ${err instanceof Error ? err.message : String(err)}`,
              });
            }
            continue;
          }

          // Unknown tool — shouldn't be reachable given the filter above.
          toolMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `[unknown_tool] no handler registered for '${toolName}'`,
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await this.client.images.generate({
        model: opts.model,
        prompt: opts.prompt,
        n: 1,
        size,
        response_format: 'b64_json',
      } as any);
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

/**
 * OpenAI's reasoning models (o1, o3, o4, gpt-5) reject the legacy
 * `max_tokens` parameter and require `max_completion_tokens`. This
 * matcher is intentionally lenient — any future *-mini / *-pro / *-thinking
 * variants still match, so we don't have to update this list every
 * time OpenAI ships a new SKU.
 */
function isReasoningModel(model: string): boolean {
  // gpt-5 and successors
  if (/^gpt-[5-9]\b/i.test(model)) return true;
  // o-series reasoning models
  if (/^o[1-9](-|$)/i.test(model)) return true;
  return false;
}

/**
 * Collapse an OpenAI streaming response into the same shape as a
 * non-streaming ChatCompletion so the downstream tool-loop logic
 * doesn't have to branch.
 *
 * Emits each text delta via `onToken` as it arrives. Tool-call
 * fragments are accumulated into complete tool_calls in the assembled
 * choice — they're NOT streamed to onToken (those become tool_call
 * events at the worker level).
 */
async function assembleOpenAIChunks(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  onToken: (delta: string) => void | Promise<void>,
  fallbackModel: string,
): Promise<OpenAI.Chat.ChatCompletion> {
  let id = '';
  let model = fallbackModel;
  let role: 'assistant' = 'assistant';
  let contentBuf = '';
  let finishReason: OpenAI.Chat.ChatCompletion.Choice['finish_reason'] | null = null;
  const toolCalls = new Map<
    number,
    { id: string; type: 'function'; function: { name: string; arguments: string } }
  >();
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;

  for await (const chunk of stream) {
    if (chunk.id) id = chunk.id;
    if (chunk.model) model = chunk.model;
    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        contentBuf += delta.content;
        try {
          await onToken(delta.content);
        } catch {
          // Swallow callback errors so the stream keeps draining.
        }
      }
      // delta.role is 'assistant' on the first chunk; subsequent
      // chunks omit it. Same for tool_calls deltas.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tcDeltas = (delta as any).tool_calls as
        | Array<{
            index: number;
            id?: string;
            type?: 'function';
            function?: { name?: string; arguments?: string };
          }>
        | undefined;
      if (tcDeltas) {
        for (const d of tcDeltas) {
          const existing = toolCalls.get(d.index) ?? {
            id: d.id ?? '',
            type: 'function' as const,
            function: { name: '', arguments: '' },
          };
          if (d.id) existing.id = d.id;
          if (d.function?.name) existing.function.name = d.function.name;
          if (d.function?.arguments) existing.function.arguments += d.function.arguments;
          toolCalls.set(d.index, existing);
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
      completionTokens = chunk.usage.completion_tokens ?? completionTokens;
      totalTokens = chunk.usage.total_tokens ?? totalTokens;
    }
    void role;
  }

  const orderedToolCalls = [...toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, v]) => v);

  const message: OpenAI.Chat.ChatCompletionMessage = {
    role: 'assistant',
    content: contentBuf.length > 0 ? contentBuf : null,
    refusal: null,
    ...(orderedToolCalls.length > 0 && {
      tool_calls: orderedToolCalls as OpenAI.Chat.ChatCompletionMessageToolCall[],
    }),
  };

  return {
    id: id || `chatcmpl-streamed-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason ?? 'stop',
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    },
  } as OpenAI.Chat.ChatCompletion;
}

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
  if (opts.webTools?.includes('gatewaze_search')) {
    out.push({
      type: 'function',
      function: {
        name: 'gatewaze_search',
        description:
          'Gatewaze-hosted web search (Serper.dev or DuckDuckGo HTML scrape). Use this for discovery; pair with fetch_url to read primary sources.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query.' },
            max_results: {
              type: 'integer',
              description: 'How many results to return (default 6, max 20).',
            },
          },
          required: ['query'],
        },
        strict: false,
      },
    });
  }
  // Recipe-injected extra tools (MCP server tools, builtin: memory).
  // Forwarded as OpenAI functions; strict: false because MCP schemas
  // aren't guaranteed to fit OpenAI's strict-mode subset (no `oneOf`,
  // no defaults, every property required, etc.).
  for (const t of opts.extraTools ?? []) {
    out.push({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
        strict: false,
      },
    });
  }
  // OpenAI's chat.completions API has no native server-side web_search
  // (as of 2026-05). Use gatewaze_search above when discovery is needed.
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
