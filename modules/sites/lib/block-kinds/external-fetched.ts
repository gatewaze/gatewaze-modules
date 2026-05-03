/**
 * external-fetched block kind — third-party API fetch baked at publish.
 *
 * Per spec-content-modules-git-architecture §9.2: ALWAYS build-time
 * (no runtime external dependency from the published site). Refresh
 * via republish (manual / scheduled / webhook from the external system).
 *
 * Theme author declares blocks like:
 *
 *   /* @gatewaze:block kind="external-fetched" name="Weather"
 *      cache_ttl_seconds="3600" auth_secret_key="OPENWEATHERMAP_KEY" *​/
 *   export function Weather(props: WeatherProps) { ... }
 *
 * Per-instance config (page_blocks.kind_config):
 *   {
 *     "endpoint": "https://api.openweathermap.org/data/2.5/weather",
 *     "method": "GET",
 *     "query": { "q": "London", "units": "metric" },
 *     "headers": { "Accept": "application/json" },
 *     "auth_query_param": "appid",
 *     "fallback_content": { "temp": null }
 *   }
 *
 * The build-time fetcher:
 *   1. Resolves auth_secret_key from sites_secrets (never inlined)
 *   2. Composes the request with query params + auth + headers
 *   3. Fetches; on success, returns the JSON response which becomes
 *      the block's content (passed to the React component as props)
 *   4. On failure: returns fallback_content; logs the failure to
 *      site_republish_log so the admin sees the warning
 *   5. Per-block timeout (default 10s) + per-publish budget (default
 *      60s total across all external-fetched blocks)
 */

export interface ExternalFetchConfig {
  endpoint: string;
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  /**
   * Where to attach the API key from sites_secrets[auth_secret_key].
   * - 'query': appended as a query param named by auth_query_param (default 'apikey')
   * - 'header': sent as Authorization: Bearer <secret>
   * - 'header_custom': sent in the auth_header_name header
   */
  auth_location?: 'query' | 'header' | 'header_custom' | 'none';
  auth_query_param?: string;
  auth_header_name?: string;
  /** JSONPath-ish key to extract from the response (e.g. 'data.items'). Defaults to entire response. */
  response_path?: string;
  /** Returned when the fetch fails (timeout, non-2xx, network error). */
  fallback_content?: Record<string, unknown>;
  /** Override block-def cache_ttl_seconds. */
  cache_ttl_seconds?: number;
  /** Per-block timeout (ms). */
  timeout_ms?: number;
}

export interface ExternalFetchResult {
  content: Record<string, unknown>;
  /** Whether fallback_content was used (fetch failed). */
  usedFallback: boolean;
  /** Error message if fallback used. */
  error?: string;
  /** Response status code (if HTTP error). */
  statusCode?: number;
  /** Duration in ms. */
  durationMs: number;
  /** When the fetch ran. */
  fetchedAt: string;
}

export interface ExternalFetcherDeps {
  /**
   * Resolves a site's secret value by key. Returns null if not set.
   */
  resolveSecret: (siteId: string, key: string) => Promise<string | null>;
  /** Fetch override (tests). */
  fetch?: typeof globalThis.fetch;
  /** Per-publish total budget in ms (default 60000). */
  publishBudgetMs?: number;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BUDGET_MS = 60_000;

export class ExternalFetcher {
  private remainingBudgetMs: number;
  private fetchFn: typeof globalThis.fetch;

  constructor(private readonly deps: ExternalFetcherDeps) {
    this.remainingBudgetMs = deps.publishBudgetMs ?? DEFAULT_BUDGET_MS;
    this.fetchFn = deps.fetch ?? globalThis.fetch;
  }

  /**
   * Run a single external fetch for an external-fetched block instance.
   */
  async fetchOne(args: {
    siteId: string;
    blockDefId: string;
    blockDefName: string;
    /** Block-def-level marker attribute. */
    authSecretKey?: string;
    config: ExternalFetchConfig;
  }): Promise<ExternalFetchResult> {
    const startedAt = Date.now();
    const fetchedAt = new Date().toISOString();
    const timeoutMs = args.config.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    if (this.remainingBudgetMs <= 0) {
      this.deps.logger.warn('external-fetcher: per-publish budget exhausted; using fallback', {
        block: args.blockDefName,
      });
      return {
        content: args.config.fallback_content ?? {},
        usedFallback: true,
        error: 'publish_budget_exhausted',
        durationMs: 0,
        fetchedAt,
      };
    }

    try {
      // Resolve auth secret if needed
      let authSecret: string | null = null;
      if (args.authSecretKey && args.config.auth_location && args.config.auth_location !== 'none') {
        authSecret = await this.deps.resolveSecret(args.siteId, args.authSecretKey);
        if (!authSecret) {
          this.deps.logger.warn('external-fetcher: auth secret missing; using fallback', {
            block: args.blockDefName,
            key: args.authSecretKey,
          });
          return {
            content: args.config.fallback_content ?? {},
            usedFallback: true,
            error: `auth_secret_missing: ${args.authSecretKey}`,
            durationMs: Date.now() - startedAt,
            fetchedAt,
          };
        }
      }

      // Compose URL with query params + optional auth-in-query
      const url = new URL(args.config.endpoint);
      for (const [k, v] of Object.entries(args.config.query ?? {})) {
        url.searchParams.set(k, String(v));
      }
      if (authSecret && args.config.auth_location === 'query') {
        url.searchParams.set(args.config.auth_query_param ?? 'apikey', authSecret);
      }

      // Headers
      const headers: Record<string, string> = { ...(args.config.headers ?? {}) };
      if (authSecret && args.config.auth_location === 'header') {
        headers.Authorization = `Bearer ${authSecret}`;
      }
      if (authSecret && args.config.auth_location === 'header_custom' && args.config.auth_header_name) {
        headers[args.config.auth_header_name] = authSecret;
      }

      // Fetch with timeout
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await this.fetchFn(url.toString(), {
          method: args.config.method ?? 'GET',
          headers,
          body: args.config.body ? JSON.stringify(args.config.body) : undefined,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const durationMs = Date.now() - startedAt;
      this.remainingBudgetMs -= durationMs;

      if (!response.ok) {
        return {
          content: args.config.fallback_content ?? {},
          usedFallback: true,
          error: `http_${response.status}`,
          statusCode: response.status,
          durationMs,
          fetchedAt,
        };
      }

      const json = (await response.json()) as Record<string, unknown>;
      const extracted = args.config.response_path ? extractPath(json, args.config.response_path) : json;
      const content = (extracted ?? args.config.fallback_content ?? {}) as Record<string, unknown>;

      return { content, usedFallback: false, durationMs, fetchedAt };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      this.remainingBudgetMs -= durationMs;
      const error = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn('external-fetcher: fetch failed', { block: args.blockDefName, error });
      return {
        content: args.config.fallback_content ?? {},
        usedFallback: true,
        error,
        durationMs,
        fetchedAt,
      };
    }
  }

  metrics(): { remainingBudgetMs: number } {
    return { remainingBudgetMs: this.remainingBudgetMs };
  }
}

/**
 * Extract a value at a dot-notation path from an object.
 * Supports array indices: 'data.items[0].name'.
 */
export function extractPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split(/\.|\[(\d+)\]/).filter((p) => p !== undefined && p !== '');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      const idx = parseInt(part, 10);
      if (Number.isNaN(idx)) return undefined;
      current = current[idx];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}
