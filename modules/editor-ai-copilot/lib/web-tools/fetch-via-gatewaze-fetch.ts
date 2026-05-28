/**
 * fetch_url backend — dual-mode.
 *
 * Per `spec-ai-chatbot-web-search.md` §3.2 the function is exception-free.
 * Every failure mode (invalid scheme, SSRF rejection, upstream 5xx,
 * timeout) returns `{ ok: false, errorCode, errorMessage }`.
 *
 * Two backends:
 *
 *   - **internal** (default): POST direct to `scrapling-fetcher` with the
 *     shared internal token. Same path scraper workers use today. No
 *     per-tenant quotas, no API key. Cluster-internal traffic only.
 *     scrapling-fetcher returns HTML; we run it through the readability
 *     parser (parsers/html-parser.ts) to get plain text for the model.
 *
 *   - **external**: POST to the gatewaze-fetch publicApi with a per-
 *     tenant Bearer key. Goes through the per-tenant quota + billing
 *     ledger. Use this when the editor-ai-copilot runs outside the
 *     cluster boundary (rare for the canvas surface, but supported).
 *
 * The dispatcher (lib/web-tools/dispatch.ts) picks the mode based on
 * env vars:
 *   - SCRAPLING_FETCHER_URL + SCRAPLING_INTERNAL_TOKEN  → internal
 *   - GATEWAZE_FETCH_BASE_URL + GATEWAZE_FETCH_API_KEY  → external
 * If both are set, internal wins (cheaper, no key rotation overhead).
 */

import { assertPublicHost } from './ssrf-guard.js';
import type { FetchResult } from './types.js';
import { parseHtml } from '../../api/parsers/html-parser.js';

type InternalOptions = {
  backend: 'scrapling';
  baseUrl: string;
  internalToken: string;
  /** scrapling-fetcher modes: fast | stealth | browser. Defaults to 'fast'. */
  mode?: 'fast' | 'stealth' | 'browser';
  /** Wall-clock cap on the upstream call. Defaults to 15s. */
  timeoutMs?: number;
  /** Hard byte ceiling on the response body returned to the model. */
  maxBytes: number;
};

type ExternalOptions = {
  backend: 'gatewaze-fetch';
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  maxBytes: number;
  timeoutMs?: number;
};

export type FetchUrlOptions = InternalOptions | ExternalOptions;

const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchViaGatewazeFetch(
  url: string,
  opts: FetchUrlOptions,
): Promise<FetchResult> {
  // 1. Local URL validation — scheme + SSRF. Defence in depth: both
  //    backends run their own check too.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, errorCode: 'fetch_url_blocked', errorMessage: 'Malformed URL.' };
  }
  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      errorCode: 'fetch_url_blocked',
      errorMessage: `Only https:// URLs are allowed (got ${parsed.protocol}).`,
    };
  }
  const hostCheck = await assertPublicHost(parsed.hostname);
  if (!hostCheck.ok) {
    return { ok: false, errorCode: 'fetch_url_blocked', errorMessage: hostCheck.reason };
  }

  return opts.backend === 'scrapling'
    ? fetchViaScrapling(url, opts)
    : fetchViaPublicApi(url, opts);
}

// ---------------------------------------------------------------------------
// Internal mode — direct to scrapling-fetcher
// ---------------------------------------------------------------------------

async function fetchViaScrapling(url: string, opts: InternalOptions): Promise<FetchResult> {
  try {
    const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/fetch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.internalToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        mode: opts.mode ?? 'fast',
        extract_next_data: false,
        timeout_ms: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        ok: false,
        errorCode: res.status === 413 ? 'fetch_url_too_large' : 'fetch_upstream_failed',
        errorMessage: `scrapling-fetcher HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      };
    }
    const body = (await res.json()) as {
      html?: unknown;
      final_url?: unknown;
      bytes_in?: unknown;
      mode_used?: unknown;
    };
    if (typeof body.html !== 'string') {
      return {
        ok: false,
        errorCode: 'fetch_upstream_failed',
        errorMessage: 'scrapling-fetcher returned no html body.',
      };
    }
    const finalUrl = typeof body.final_url === 'string' && body.final_url.length > 0
      ? body.final_url
      : url;
    const bytesIn = typeof body.bytes_in === 'number' ? body.bytes_in : Buffer.byteLength(body.html, 'utf8');
    const modeUsed: 'static' | 'browser' = body.mode_used === 'browser' ? 'browser' : 'static';

    // Strip HTML → plain text via readability. The parser also handles
    // the cheerio fallback for paywalled / SPA pages.
    const parsed = parseHtml(Buffer.from(body.html, 'utf8'), { sourceUrl: finalUrl });
    if (!parsed.ok) {
      return {
        ok: false,
        errorCode: 'fetch_upstream_failed',
        errorMessage: `Could not extract text from page: ${parsed.reason}`,
      };
    }
    // Hard cap on returned text (the loop also truncates to fetch_url_max_bytes,
    // but enforcing once here avoids passing large buffers around).
    const text = parsed.text.length > opts.maxBytes ? parsed.text.slice(0, opts.maxBytes) : parsed.text;

    return {
      ok: true,
      text,
      final_url: finalUrl,
      bytes: bytesIn,
      mode: modeUsed,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return {
        ok: false,
        errorCode: 'fetch_upstream_failed',
        errorMessage: `scrapling-fetcher timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`,
      };
    }
    return {
      ok: false,
      errorCode: 'fetch_upstream_failed',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// External mode — gatewaze-fetch publicApi
// ---------------------------------------------------------------------------

async function fetchViaPublicApi(url: string, opts: ExternalOptions): Promise<FetchResult> {
  try {
    const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/fetch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'X-Gatewaze-Tenant': opts.tenantId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url, mode: 'auto', max_bytes: opts.maxBytes }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        ok: false,
        errorCode: res.status === 413 ? 'fetch_url_too_large' : 'fetch_upstream_failed',
        errorMessage: `gatewaze-fetch HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      };
    }
    const body = (await res.json()) as {
      text?: unknown;
      final_url?: unknown;
      bytes?: unknown;
      mode?: unknown;
    };
    if (
      typeof body.text !== 'string' ||
      typeof body.final_url !== 'string' ||
      typeof body.bytes !== 'number'
    ) {
      return {
        ok: false,
        errorCode: 'fetch_upstream_failed',
        errorMessage: 'gatewaze-fetch returned malformed response body.',
      };
    }
    const mode: 'static' | 'browser' = body.mode === 'browser' ? 'browser' : 'static';
    return { ok: true, text: body.text, final_url: body.final_url, bytes: body.bytes, mode };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return {
        ok: false,
        errorCode: 'fetch_upstream_failed',
        errorMessage: `gatewaze-fetch timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`,
      };
    }
    return {
      ok: false,
      errorCode: 'fetch_upstream_failed',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
