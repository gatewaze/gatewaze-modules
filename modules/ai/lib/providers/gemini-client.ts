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

    try {
      for (let iter = 0; iter < MAX_LOOP_ITERATIONS; iter++) {
        const response = await this.callGemini(
          opts.model,
          {
            systemInstruction: { parts: [{ text: opts.systemPrompt }] },
            contents,
            tools,
            generationConfig: {
              maxOutputTokens: opts.maxOutputTokens,
            },
          },
          controller.signal,
        );

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
              durationMs: Date.now() - started,
              model: lastModel,
              fetchedUrls,
              webSearchCount: 0,
            };
          }
        } else if (cand.finishReason === 'STOP') {
          return {
            narrative: extractNarrative(cand.content.parts),
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

        // ── fetch_url calls?
        const fetchCalls = cand.content.parts.filter(
          (p) => p.functionCall?.name === 'fetch_url',
        );
        if (fetchCalls.length === 0) {
          throw new InvalidProviderOutputError(
            `model stopped (finishReason=${cand.finishReason}) without emitting the structured tool`,
            'gemini',
          );
        }

        const toolParts: GeminiPart[] = [];
        for (const call of fetchCalls) {
          const args = call.functionCall?.args ?? {};
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
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildTools(opts: RunConversationOpts): unknown[] {
  const functionDeclarations: unknown[] = [];
  if (opts.structuredTool) {
    functionDeclarations.push({
      name: opts.structuredTool.name,
      description: opts.structuredTool.description,
      parameters: opts.structuredTool.inputSchema,
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
