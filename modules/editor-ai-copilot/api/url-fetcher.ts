/**
 * SSRF-safe URL fetcher for the documents endpoint.
 *
 * Per spec-canvas-ai-copilot.md §0000000a:
 *
 *   - https only
 *   - resolved IP cannot be RFC1918 / loopback / link-local
 *   - max 3 redirects (each re-validated)
 *   - 10s wall clock
 *   - 10 MB response body cap (stream-then-abort on overshoot)
 *   - no cookies / Authorization forwarded
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { canvasAiConfig } from '../lib/canvas-ai-config.js';
import { rewriteGoogleDocUrl } from './google-docs-rewriter.js';

const PRIVATE_IPV4_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|0\.|255\.255\.255\.255$)/;

function isPrivateIp(ip: string): boolean {
  if (PRIVATE_IPV4_RE.test(ip)) return true;
  // IPv6 loopback + link-local + ULA.
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  if (lower.startsWith('fe80:')) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
  if (lower === '::' || lower === '::ffff:0:0') return true;
  // IPv4-mapped IPv6 — re-test the IPv4 portion.
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return PRIVATE_IPV4_RE.test(v4Mapped[1]!);
  return false;
}

export interface UrlFetchResult {
  finalUrl: string;
  contentType: string;
  body: Buffer;
  redirectCount: number;
}

export class UrlFetchError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'UrlFetchError';
  }
}

async function validateUrl(rawUrl: string): Promise<{ ok: true; url: URL } | UrlFetchError> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return new UrlFetchError('document_url_blocked', 'malformed URL');
  }
  if (url.protocol !== 'https:') {
    return new UrlFetchError('document_url_blocked', `scheme ${url.protocol} not allowed (https only)`);
  }
  // Resolve host → check IP is not private. Re-resolve before connect
  // happens via the fetch call below; this is the resolver-layer
  // check to refuse early.
  let resolved: { address: string }[];
  try {
    resolved = await dnsLookup(url.hostname, { all: true });
  } catch {
    return new UrlFetchError('document_url_blocked', `DNS lookup failed for ${url.hostname}`);
  }
  for (const r of resolved) {
    if (isPrivateIp(r.address)) {
      return new UrlFetchError('document_url_blocked', `host ${url.hostname} resolves to private IP ${r.address}`);
    }
  }
  return { ok: true, url };
}

/**
 * Fetch a URL with full SSRF protection. Returns the body as a Buffer
 * plus the Content-Type the response advertised. Caller picks the
 * right parser based on Content-Type.
 */
export async function safeFetchUrl(rawUrl: string): Promise<UrlFetchResult | UrlFetchError> {
  // Pre-rewrite Google Doc URLs to their export endpoint. Done before
  // SSRF validation so we still validate the rewritten URL.
  let urlToFetch: URL;
  try {
    const initial = new URL(rawUrl);
    const rewritten = rewriteGoogleDocUrl(initial);
    urlToFetch = rewritten ?? initial;
  } catch {
    return new UrlFetchError('document_url_blocked', 'malformed URL');
  }

  let redirects = 0;
  let currentUrl = urlToFetch;

  while (redirects <= canvasAiConfig.urlFetchMaxRedirects) {
    const validated = await validateUrl(currentUrl.toString());
    if (validated instanceof UrlFetchError) return validated;
    currentUrl = validated.url;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), canvasAiConfig.urlFetchTimeoutMs);

    try {
      const res = await fetch(currentUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          // Identify ourselves; do NOT send cookies or auth.
          'user-agent': 'GatewazeBot/1.0 (+https://example.com)',
          accept: 'text/html,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,*/*;q=0.5',
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) {
          return new UrlFetchError('document_fetch_failed', `redirect with no Location header (status ${res.status})`);
        }
        redirects += 1;
        if (redirects > canvasAiConfig.urlFetchMaxRedirects) {
          return new UrlFetchError('document_fetch_failed', 'redirect chain too long');
        }
        currentUrl = new URL(loc, currentUrl);
        continue;
      }

      if (res.status >= 400 && res.status < 500) {
        if (res.status === 401 || res.status === 403) {
          return new UrlFetchError('document_not_public', `upstream returned ${res.status}`);
        }
        return new UrlFetchError('document_fetch_failed', `upstream ${res.status}`);
      }

      if (res.status >= 500) {
        return new UrlFetchError('document_fetch_failed', `upstream ${res.status}`, { upstreamStatus: res.status });
      }

      // Detect Google's "doc-not-public" redirect that returns 200 HTML
      // (sometimes Google returns the login page with 200).
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      const body = await readBoundedBody(res, canvasAiConfig.maxDocUploadBytes);
      if (body instanceof UrlFetchError) return body;

      if (currentUrl.host === 'docs.google.com' && contentType.includes('text/html')) {
        // Public Google Docs export endpoint returns text/plain on
        // success; if we got HTML back it's the login redirect.
        return new UrlFetchError('document_not_public', 'Google Doc is not publicly shared');
      }

      return {
        finalUrl: currentUrl.toString(),
        contentType,
        body,
        redirectCount: redirects,
      };
    } catch (err) {
      if (controller.signal.aborted) {
        return new UrlFetchError('document_fetch_timeout', 'fetch exceeded wall-clock limit');
      }
      return new UrlFetchError(
        'document_fetch_failed',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return new UrlFetchError('document_fetch_failed', 'unreachable code: redirect loop');
}

async function readBoundedBody(res: Response, maxBytes: number): Promise<Buffer | UrlFetchError> {
  // ReadableStream → bounded reader. Abort on overshoot.
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        return new UrlFetchError('document_too_large', `response > ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}
