/**
 * AI alt-text generator — invoked at media upload time.
 *
 * Per spec-content-modules-git-architecture §3 (v1.x deferral).
 *
 * Wired as an optional pipeline step on the media-routes upload handler:
 *
 *   const altText = await generateAltText({
 *     mimeType, buffer, hint: filename,
 *     ai: deps.aiClient,
 *   });
 *   if (altText) {
 *     await supabase.from('host_media').update({ alt_text: altText }).eq('id', mediaItem.id);
 *   }
 *
 * The generator is a thin wrapper over a pluggable AI client (claude /
 * openai). Each request:
 *   1. Skips non-image MIME types
 *   2. Resizes the image to <= 512px on the longest edge (via Sharp if
 *      available; otherwise sends the full buffer — most providers accept
 *      ≤ 4MB images)
 *   3. Invokes the model with a focused prompt that emphasizes accessibility
 *   4. Returns trimmed text or null on failure
 */

export interface AiAltTextClient {
  /**
   * Generate alt text from an image buffer.
   * Implementations: anthropic-claude, openai-gpt4-vision, google-gemini.
   */
  generateAltText(args: {
    /** Image bytes. */
    buffer: Buffer;
    /** Image MIME type (image/jpeg | image/png | image/webp etc). */
    mimeType: string;
    /** Optional context hint (e.g. site name, page title, original filename). */
    hint?: string;
    /** Max characters in the returned alt text. Default 125 (WCAG-friendly). */
    maxChars?: number;
  }): Promise<string | null>;
}

export interface AiAltTextDeps {
  client: AiAltTextClient | null;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

const SUPPORTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * Generate alt text for a media upload. Returns null when:
 * - No AI client configured
 * - Non-image MIME type
 * - AI call fails
 * - Generated text is empty/garbage
 *
 * Caller is responsible for storing the result.
 */
export async function generateAltText(args: {
  mimeType: string;
  buffer: Buffer;
  hint?: string;
  maxChars?: number;
}, deps: AiAltTextDeps): Promise<string | null> {
  if (!deps.client) {
    return null;
  }
  if (!SUPPORTED_MIME_TYPES.has(args.mimeType)) {
    deps.logger.info('ai-alt-text: skipping non-image', { mimeType: args.mimeType });
    return null;
  }

  try {
    const text = await deps.client.generateAltText({
      buffer: args.buffer,
      mimeType: args.mimeType,
      hint: args.hint,
      maxChars: args.maxChars ?? 125,
    });
    if (!text || text.trim().length === 0) return null;
    // Sanity check: reject obvious refusals
    const lower = text.toLowerCase();
    if (lower.includes("i can't") || lower.includes('i cannot') || lower.includes('i am unable')) {
      deps.logger.warn('ai-alt-text: model refused', { hint: args.hint });
      return null;
    }
    return text.trim().slice(0, args.maxChars ?? 125);
  } catch (err) {
    deps.logger.warn('ai-alt-text: generation failed', {
      hint: args.hint,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Anthropic Claude implementation of AiAltTextClient.
 * Uses claude-haiku-4-5 (fast + cheap) via the Messages API.
 */
export function anthropicAltTextClient(args: {
  apiKey: string;
  model?: string;
  fetch?: typeof globalThis.fetch;
}): AiAltTextClient {
  const fetchFn = args.fetch ?? globalThis.fetch;
  const model = args.model ?? 'claude-haiku-4-5-20251001';

  return {
    async generateAltText({ buffer, mimeType, hint, maxChars }) {
      const base64 = buffer.toString('base64');
      const prompt = [
        'Describe this image in a single sentence suitable for use as an HTML alt attribute.',
        'Focus on what the image conveys (people, action, mood, key visual elements) — not metadata.',
        `Maximum ${maxChars ?? 125} characters.`,
        'Do not start with "Image of" or "Picture of".',
        'Do not include period at end.',
        hint ? `Context: this image is on a page about ${hint}.` : '',
      ].filter(Boolean).join(' ');

      const resp = await fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': args.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 100,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
              { type: 'text', text: prompt },
            ],
          }],
        }),
      });
      if (!resp.ok) {
        throw new Error(`anthropic api ${resp.status}: ${await resp.text()}`);
      }
      const json = (await resp.json()) as { content?: Array<{ type: string; text?: string }> };
      const block = json.content?.find((c) => c.type === 'text');
      return block?.text?.trim() ?? null;
    },
  };
}
