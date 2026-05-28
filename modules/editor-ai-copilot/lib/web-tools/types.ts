/**
 * Types for the web_search + fetch_url tool surface.
 * Spec: gatewaze-environments/specs/spec-ai-chatbot-web-search.md
 */

export type WebToolErrorCode =
  | 'web_search_disabled'
  | 'fetch_url_disabled'
  | 'fetch_quota_exceeded'
  | 'fetch_url_blocked'
  | 'fetch_url_too_large'
  | 'fetch_upstream_failed'
  | 'daily_cost_budget_exceeded';

/** Result of a fetch_url tool invocation — never throws (spec §3.2). */
export type FetchResult =
  | {
      ok: true;
      text: string;
      final_url: string;
      bytes: number;
      mode: 'static' | 'browser';
    }
  | {
      ok: false;
      errorCode: WebToolErrorCode;
      errorMessage: string;
    };

/** Per-turn audit-trail entry for a fetch_url invocation. */
export interface FetchedUrlAuditEntry {
  url: string;
  reason: string;
  status: number;
  byte_count: number;
  mode: 'static' | 'browser' | 'error';
  fetched_at: string;
  source: 'gatewaze-fetch';
  /** Set when ok=false; null on success. */
  error_code: WebToolErrorCode | null;
}

/** Per-turn audit-trail entry for a web_search invocation. */
export interface WebSearchAuditEntry {
  query: string;
  result_count: number;
  /** True iff this entry counts toward Anthropic's billed search count. */
  billed: boolean;
}

/** Tool-call summary surfaced to the chat-endpoint response. */
export interface ToolCallSummary {
  web_searches: ReadonlyArray<WebSearchAuditEntry>;
  fetched_urls: ReadonlyArray<FetchedUrlAuditEntry>;
}
