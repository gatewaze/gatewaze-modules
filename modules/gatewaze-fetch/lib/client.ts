/**
 * HTTP client to scrapling-fetcher (spec §2.5, §10.1).
 *
 * Always sets the X-Gatewaze-Tenant header, which the fetcher service
 * uses to discriminate external (gatewaze-fetch) traffic from internal
 * (worker) traffic for its own logging — see scrapling-fetcher §2.5.
 */

import type {
  FetchMode,
  NormalizedUrl,
  UpstreamFetchResult,
} from './types.js';

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly errorClass:
      | 'upstream_timeout'
      | 'upstream_connection_error'
      | 'upstream_pool_full'
      | 'upstream_proxy_auth'
      | 'upstream_5xx_other',
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface ClientConfig {
  baseUrl: string; // e.g. "http://scrapling-fetcher:8080"
  internalToken: string;
  // Total wall-clock timeout for the upstream HTTP call (sets a hard
  // ceiling on top of timeout_ms — defends against the upstream
  // hanging on the response stream).
  outerTimeoutMs?: number;
}

export interface ClientFetchInput {
  url: string;
  mode: FetchMode;
  extract_next_data: boolean;
  wait_for: string | null;
  timeout_ms: number;
  proxy: 'auto' | 'force' | 'never';
  user_agent?: string;
  api_key_id: string; // for the X-Gatewaze-Tenant header
  capture_screenshot?: boolean;
  screenshot_full_page?: boolean;
  screenshot_clip?: { x: number; y: number; width: number; height: number } | null;
}

export class ScraplingFetcherClient {
  constructor(private readonly cfg: ClientConfig) {}

  async fetch(input: ClientFetchInput): Promise<UpstreamFetchResult> {
    const outerTimeoutMs = this.cfg.outerTimeoutMs ?? input.timeout_ms + 5_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), outerTimeoutMs);

    try {
      const res = await fetch(`${this.cfg.baseUrl}/fetch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-token': this.cfg.internalToken,
          'x-gatewaze-tenant': input.api_key_id,
        },
        body: JSON.stringify({
          url: input.url,
          mode: input.mode,
          extract_next_data: input.extract_next_data,
          wait_for: input.wait_for,
          timeout_ms: input.timeout_ms,
          proxy: input.proxy,
          capture_screenshot: input.capture_screenshot ?? false,
          screenshot_full_page: input.screenshot_full_page ?? false,
          screenshot_clip: input.screenshot_clip ?? null,
        }),
        signal: ac.signal,
      });

      if (res.status === 504) {
        const body = await safeJson(res);
        throw new UpstreamError(
          body?.detail ?? 'upstream timeout',
          504,
          'upstream_timeout',
          true,
        );
      }
      if (res.status === 503) {
        const body = await safeJson(res);
        const detail = body?.error;
        if (detail === 'browser_pool_exhausted') {
          throw new UpstreamError(
            'browser pool exhausted',
            503,
            'upstream_pool_full',
            true,
          );
        }
        throw new UpstreamError(
          'upstream unavailable',
          503,
          'upstream_connection_error',
          true,
        );
      }
      if (res.status === 502) {
        const body = await safeJson(res);
        throw new UpstreamError(
          body?.detail ?? 'upstream error',
          502,
          'upstream_connection_error',
          true,
        );
      }
      if (!res.ok) {
        throw new UpstreamError(
          `upstream returned ${res.status}`,
          res.status,
          'upstream_5xx_other',
          false,
        );
      }

      const json = (await res.json()) as UpstreamFetchResult;
      return json;
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      if ((e as { name?: string })?.name === 'AbortError') {
        throw new UpstreamError(
          'outer timeout',
          504,
          'upstream_timeout',
          true,
        );
      }
      throw new UpstreamError(
        (e as Error)?.message ?? 'connection error',
        503,
        'upstream_connection_error',
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeJson(res: Response): Promise<{ error?: string; detail?: string } | null> {
  try {
    return (await res.json()) as { error?: string; detail?: string };
  } catch {
    return null;
  }
}
