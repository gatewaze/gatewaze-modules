/**
 * Google Gemini provider client.
 *
 * Supports:
 *   - runConversation: chat with function calling for fetch_url + a
 *     structured-output function. (Server-side google_search is on
 *     Gemini 2+ but the tool-use loop shape differs; v1 routes web
 *     research through fetch_url like the other providers.)
 *   - generateImage: gemini-2.5-flash-image ("Nano Banana") — already
 *     in use by daily-briefing.
 *
 * Uses the v1beta REST API directly (no SDK dep) — the editor team
 * found the @google/genai SDK churns too aggressively for our taste,
 * and the v1beta REST shape is stable.
 *
 * Recipe-injected `extraTools` (MCP servers, builtin: memory) are
 * honoured: each is declared as a functionDeclaration (parameters
 * run through `sanitizeSchemaForGemini` so MCP servers emitting
 * draft-2020-12 JSON Schema fields don't trip Gemini's OpenAPI-3.0-
 * subset parser) and routed through the supplied resolver.
 */

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

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_LOOP_ITERATIONS = 12;

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
  inline_data?: { mime_type: string; data: string };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  modelVersion?: string;
}

export class GeminiProviderClient implements ProviderClient {
  readonly provider = 'gemini' as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, baseUrl?: string, fetchImpl?: typeof fetch) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl ?? API_BASE).replace(/\/$/, '');
    this.fetchImpl = fetchImpl ?? fetch;
  }

  capabilities() {
    return {
      streaming: true,
      tools: true,
      web_search: true,            // server-side `google_search` tool (Gemini 2+)
      image_gen: true,
      embeddings: false,           // Gemini embeddings are available but we route through OpenAI for v1
    };
  }

  async runConversation(opts: RunConversationOpts): Promise<RunConversationResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

    const tools = buildTools(opts);
    const contents: GeminiContent[] = toGeminiContents(opts.messages);

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
        const body = {
          systemInstruction: { parts: [{ text: opts.systemPrompt }] },
          contents,
          tools,
          generationConfig: {
            maxOutputTokens: opts.maxOutputTokens,
          },
        };
        const response = opts.onToken
          ? await this.streamGemini(opts.model, body, controller.signal, opts.onToken)
          : await this.callGemini(opts.model, body, controller.signal);

        lastModel = response.modelVersion ?? opts.model;
        totalInputTokens += response.usageMetadata?.promptTokenCount ?? 0;
        totalOutputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;
        totalCachedTokens += response.usageMetadata?.cachedContentTokenCount ?? 0;

        const cand = response.candidates?.[0];
        if (!cand?.content) {
          throw new InvalidProviderOutputError('no candidate content', 'gemini');
        }

        // ── Structured-output hit?
        if (opts.structuredTool) {
          const hit = cand.content.parts.find(
            (p) => p.functionCall?.name === opts.structuredTool!.name,
          );
          if (hit?.functionCall) {
            return {
              narrative: extractNarrative(cand.content.parts),
              structured: hit.functionCall.args,
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
        } else if (cand.finishReason === 'STOP') {
          return {
            narrative: extractNarrative(cand.content.parts),
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
        //    Gemini's native googleSearch is server-side and shows up
        //    in the candidate text directly, so we don't dispatch it
        //    from here. Recipe-injected extraTools (MCP servers,
        //    builtin: memory) are recognised by name.
        const extraToolNames = new Set((opts.extraTools ?? []).map((t) => t.name));
        const toolCalls = cand.content.parts.filter(
          (p) =>
            p.functionCall?.name === 'fetch_url' ||
            p.functionCall?.name === 'gatewaze_search' ||
            extraToolNames.has(p.functionCall?.name ?? ''),
        );
        if (toolCalls.length === 0) {
          throw new InvalidProviderOutputError(
            `model stopped (finishReason=${cand.finishReason}) without emitting the structured tool`,
            'gemini',
          );
        }

        const toolParts: GeminiPart[] = [];
        for (const call of toolCalls) {
          const name = call.functionCall?.name ?? '';
          const args = call.functionCall?.args ?? {};

          if (name === 'fetch_url') {
            const url = typeof args['url'] === 'string' ? (args['url'] as string) : '';
            const reason = typeof args['reason'] === 'string' ? (args['reason'] as string) : '';

            if (!opts.resolveFetchUrl) {
              toolParts.push({
                functionResponse: {
                  name: 'fetch_url',
                  response: { error: 'fetch_url_disabled' },
                },
              });
              continue;
            }
            fetchCallsThisTurn++;
            if (fetchCallsThisTurn > (opts.fetchUrlMaxPerTurn ?? 8)) {
              toolParts.push({
                functionResponse: {
                  name: 'fetch_url',
                  response: { error: 'fetch_quota_exceeded' },
                },
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
            toolParts.push({
              functionResponse: {
                name: 'fetch_url',
                response: result.ok
                  ? { content: result.content, final_url: result.finalUrl }
                  : { error: result.error ?? 'unknown' },
              },
            });
            continue;
          }

          if (name === 'gatewaze_search') {
            const query = typeof args['query'] === 'string' ? (args['query'] as string) : '';
            const requestedMax =
              typeof args['max_results'] === 'number' && (args['max_results'] as number) > 0
                ? (args['max_results'] as number)
                : 6;
            if (!opts.resolveGatewazeSearch) {
              toolParts.push({
                functionResponse: {
                  name: 'gatewaze_search',
                  response: { error: 'gatewaze_search_disabled' },
                },
              });
              continue;
            }
            gatewazeSearchCallsThisTurn++;
            if (gatewazeSearchCallsThisTurn > (opts.gatewazeSearchMaxPerTurn ?? 6)) {
              toolParts.push({
                functionResponse: {
                  name: 'gatewaze_search',
                  response: { error: 'gatewaze_search_quota_exceeded' },
                },
              });
              continue;
            }
            const searchResult = await opts.resolveGatewazeSearch(query, requestedMax);
            if (searchResult.ok) gatewazeSearchCount++;
            toolParts.push({
              functionResponse: {
                name: 'gatewaze_search',
                response: searchResult.ok
                  ? { backend: searchResult.backend, results: searchResult.results }
                  : { error: searchResult.error ?? 'unknown' },
              },
            });
            continue;
          }

          // ── extraTools (recipe-injected: MCP servers, memory) ─────
          // Gemini's functionResponse takes a plain object, so we
          // wrap non-object resolver results in `{ result: ... }` to
          // keep the contract uniform regardless of MCP server shape.
          const extra = (opts.extraTools ?? []).find((t) => t.name === name);
          if (extra) {
            try {
              const result = await extra.resolve(args as Record<string, unknown>);
              const responseObj =
                result && typeof result === 'object' && !Array.isArray(result)
                  ? (result as Record<string, unknown>)
                  : { result };
              toolParts.push({
                functionResponse: { name, response: responseObj },
              });
            } catch (err) {
              toolParts.push({
                functionResponse: {
                  name,
                  response: { error: err instanceof Error ? err.message : String(err) },
                },
              });
            }
            continue;
          }

          // Unknown tool — should be unreachable given the filter above.
          toolParts.push({
            functionResponse: {
              name,
              response: { error: `unknown_tool: no handler registered for '${name}'` },
            },
          });
        }

        contents.push({ role: 'model', parts: cand.content.parts });
        contents.push({ role: 'user', parts: toolParts });
      }

      throw new InvalidProviderOutputError(
        `tool loop exceeded MAX_LOOP_ITERATIONS=${MAX_LOOP_ITERATIONS}`,
        'gemini',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async generateImage(opts: GenerateImageOpts): Promise<GenerateImageResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      // Reference images go FIRST, then the text instruction. This is
      // the "see this, then do this" pattern Gemini's image-conditioned
      // generation expects — putting the prompt before the references
      // weakens the visual anchoring substantially.
      const parts: Array<Record<string, unknown>> = [];
      for (const ref of opts.referenceImages ?? []) {
        parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.base64 } });
      }
      parts.push({ text: opts.prompt });

      const response = await this.callGemini(
        opts.model,
        {
          contents: [{ role: 'user', parts }],
          generationConfig: {
            responseModalities: ['IMAGE'],
            ...(opts.aspectRatio
              ? { imageConfig: { aspectRatio: opts.aspectRatio } }
              : {}),
          },
        },
        controller.signal,
      );
      const part = response.candidates?.[0]?.content?.parts.find(
        (p) => Boolean(p.inlineData?.data) || Boolean(p.inline_data?.data),
      );
      const inline = part?.inlineData ?? part?.inline_data;
      if (!inline?.data) {
        throw new InvalidProviderOutputError(
          'Gemini response contained no image data',
          'gemini',
        );
      }
      const mimeType =
        ('mimeType' in inline && inline.mimeType) ||
        ('mime_type' in inline && (inline as { mime_type?: string }).mime_type) ||
        'image/png';
      return {
        imageBytes: Buffer.from(inline.data, 'base64'),
        mimeType,
        prompt: opts.prompt,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private async callGemini(
    model: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<GeminiResponse> {
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw new ProviderTimeoutError('gemini');
      throw new ProviderError(
        err instanceof Error ? err.message : String(err),
        'gemini',
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const retryable = response.status >= 500 || response.status === 429;
      if (response.status === 429) {
        throw new ProviderRateLimitError('gemini', null);
      }
      throw new ProviderError(
        `Gemini ${response.status}: ${text.slice(0, 400)}`,
        'gemini',
        response.status,
        retryable,
      );
    }
    return (await response.json()) as GeminiResponse;
  }

  /**
   * Streaming variant — hits :streamGenerateContent with SSE framing,
   * emits text deltas through `onToken`, and assembles the chunks into
   * a synthetic GeminiResponse the downstream loop logic can consume
   * unchanged.
   *
   * Spec-ai-job-runner §4.2.
   */
  private async streamGemini(
    model: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
    onToken: (delta: string) => void | Promise<void>,
  ): Promise<GeminiResponse> {
    const url =
      `${this.baseUrl}/models/${encodeURIComponent(model)}` +
      `:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw new ProviderTimeoutError('gemini');
      throw new ProviderError(
        err instanceof Error ? err.message : String(err),
        'gemini',
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const retryable = response.status >= 500 || response.status === 429;
      if (response.status === 429) {
        throw new ProviderRateLimitError('gemini', null);
      }
      throw new ProviderError(
        `Gemini ${response.status}: ${text.slice(0, 400)}`,
        'gemini',
        response.status,
        retryable,
      );
    }
    if (!response.body) {
      // No body but 200 — degrade to JSON parse.
      return (await response.json()) as GeminiResponse;
    }

    // Parse server-sent events. Each event arrives as `data: <json>`
    // followed by a blank line. Lines without `data:` (e.g. event id
    // comments) are ignored.
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    const partials: GeminiResponse[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nlIdx: number;
        while ((nlIdx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nlIdx).replace(/\r$/, '');
          buf = buf.slice(nlIdx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload.length === 0) continue;
          let parsed: GeminiResponse;
          try {
            parsed = JSON.parse(payload) as GeminiResponse;
          } catch {
            continue;
          }
          partials.push(parsed);
          // Emit text deltas from any candidate.parts[i].text on this
          // chunk. We don't attempt to dedupe across candidates — each
          // delta is the new content for that chunk.
          for (const cand of parsed.candidates ?? []) {
            for (const part of cand.content?.parts ?? []) {
              if (typeof (part as { text?: string }).text === 'string') {
                const t = (part as { text: string }).text;
                if (t.length > 0) {
                  try {
                    await onToken(t);
                  } catch {
                    // ignore callback errors
                  }
                }
              }
            }
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // best effort
      }
    }
    return mergeGeminiPartials(partials);
  }
}

/**
 * Stitch the streamed chunks back into a single GeminiResponse for the
 * downstream tool-loop logic. Each chunk's text is concatenated; tool
 * calls (functionCall parts) and finishReason are taken from the LAST
 * chunk that carries them.
 */
function mergeGeminiPartials(partials: GeminiResponse[]): GeminiResponse {
  if (partials.length === 0) {
    return { candidates: [], usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 } };
  }
  // Aggregate text per (candidateIndex, partIndex) — Gemini sends new
  // content as additional parts OR as deltas to existing parts. We
  // treat each chunk's parts as additive; non-text parts are merged
  // by reference from the LAST chunk that includes them.
  type Candidate = NonNullable<GeminiResponse['candidates']>[number];
  const textsByCandidate = new Map<number, string>();
  const lastByCandidate = new Map<number, Candidate>();
  let usagePrompt = 0;
  let usageCompletion = 0;
  let usageCached = 0;
  for (const p of partials) {
    if (p.usageMetadata) {
      usagePrompt = p.usageMetadata.promptTokenCount ?? usagePrompt;
      usageCompletion = p.usageMetadata.candidatesTokenCount ?? usageCompletion;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cachedField = (p.usageMetadata as any).cachedContentTokenCount;
      if (typeof cachedField === 'number') usageCached = cachedField;
    }
    for (let i = 0; i < (p.candidates ?? []).length; i++) {
      const cand = (p.candidates ?? [])[i]!;
      lastByCandidate.set(i, cand);
      for (const part of cand.content?.parts ?? []) {
        if (typeof (part as { text?: string }).text === 'string') {
          textsByCandidate.set(
            i,
            (textsByCandidate.get(i) ?? '') + (part as { text: string }).text,
          );
        }
      }
    }
  }
  const mergedCandidates: Candidate[] = [];
  for (const [idx, last] of lastByCandidate.entries()) {
    const text = textsByCandidate.get(idx) ?? '';
    const nonTextParts =
      last.content?.parts?.filter(
        (p: unknown) => typeof (p as { text?: string }).text !== 'string',
      ) ?? [];
    const parts: Array<Record<string, unknown>> = [];
    if (text.length > 0) parts.push({ text });
    parts.push(...(nonTextParts as Array<Record<string, unknown>>));
    mergedCandidates.push({
      ...last,
      content: {
        ...(last.content ?? { role: 'model' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parts: parts as any,
      },
    });
  }
  return {
    candidates: mergedCandidates,
    usageMetadata: {
      promptTokenCount: usagePrompt,
      candidatesTokenCount: usageCompletion,
      ...(usageCached && { cachedContentTokenCount: usageCached }),
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildTools(opts: RunConversationOpts): unknown[] {
  const functionDeclarations: unknown[] = [];
  if (opts.structuredTool) {
    functionDeclarations.push({
      name: opts.structuredTool.name,
      description: opts.structuredTool.description,
      parameters: sanitizeSchemaForGemini(opts.structuredTool.inputSchema),
    });
  }
  if (opts.webTools?.includes('fetch_url')) {
    functionDeclarations.push({
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
    });
  }
  if (opts.webTools?.includes('gatewaze_search')) {
    functionDeclarations.push({
      name: 'gatewaze_search',
      description:
        'Gatewaze-hosted web search (Serper.dev or DuckDuckGo HTML scrape). Use for discovery; pair with fetch_url to read sources.',
      parameters: sanitizeSchemaForGemini({
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          max_results: {
            type: 'integer',
            description: 'How many results to return (default 6, max 20).',
          },
        },
        required: ['query'],
      }),
    });
  }
  // Recipe-injected extra tools (MCP servers, builtin: memory).
  // Schemas are run through the Gemini sanitiser since MCP servers
  // can emit draft-2020-12 JSON Schema that Gemini's parser rejects.
  for (const t of opts.extraTools ?? []) {
    functionDeclarations.push({
      name: t.name,
      description: t.description,
      parameters: sanitizeSchemaForGemini(t.inputSchema),
    });
  }
  const tools: unknown[] = [];
  if (functionDeclarations.length > 0) {
    tools.push({ functionDeclarations });
  }
  if (opts.webTools?.includes('web_search')) {
    // Gemini 2+ ships a server-side google_search tool. Cheaper than
    // having the model call fetch_url for discovery; let the model
    // mix-and-match.
    tools.push({ googleSearch: {} });
  }
  return tools;
}

/**
 * Strip JSON-Schema fields Gemini's tool-parameter parser doesn't
 * recognize. The Gemini Function Calling API consumes an OpenAPI-3.0
 * subset; anything draft-2020-12 (additionalProperties, $schema,
 * definitions, etc.) raises a 400 INVALID_ARGUMENT. Recursively walks
 * the schema, dropping the unsupported keys but otherwise preserving
 * shape (type/properties/required/items/enum/format/description/nullable).
 */
function sanitizeSchemaForGemini(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(sanitizeSchemaForGemini);
  if (!input || typeof input !== 'object') return input;
  const unsupported = new Set([
    'additionalProperties',
    '$schema',
    '$id',
    '$ref',
    'definitions',
    '$defs',
    'oneOf',
    'anyOf',
    'allOf',
    'not',
    'patternProperties',
    'const',
    'examples',
    'default',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'uniqueItems',
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (unsupported.has(k)) continue;
    out[k] = sanitizeSchemaForGemini(v);
  }
  return out;
}

function toGeminiContents(messages: ConversationMessage[]): GeminiContent[] {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m): GeminiContent => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
}

function extractNarrative(parts: GeminiPart[]): string {
  return parts
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n')
    .trim();
}
