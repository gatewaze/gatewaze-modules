/**
 * Shared types for gatewaze-fetch (spec §5, §6, §10, §11).
 */

// --------------------------------------------------------------- modes
export type FetchMode = 'fast' | 'stealth' | 'browser';
export type ResponseStorage = 'inline' | 'signed_url';
export type Surface = 'rest' | 'mcp_stdio' | 'mcp_http';

export type ExtractKind =
  | 'html'
  | 'markdown'
  | 'metadata'
  | 'next_data'
  | 'links'
  | 'json_ld';

// ---------------------------------------------------------- screenshot
export interface ScreenshotOptions {
  full_page?: boolean;
  format?: 'png' | 'jpeg';
  clip?: { x: number; y: number; width: number; height: number } | null;
}

// --------------------------------------------------------- request body
// Shape accepted by POST /api/v1/fetch (spec §5.3).
export interface FetchInput {
  url: string;
  mode?: FetchMode;
  extract?: ExtractKind[];
  wait_for?: string | null;
  timeout_ms?: number;
  ignore_robots?: boolean;
  screenshot?: boolean | ScreenshotOptions;
  user_agent?: string | null;
  response_storage?: ResponseStorage;
}

// --------------------------------------------------------- normalized URL
export interface NormalizedUrl {
  href: string; // canonical full URL
  scheme: 'http' | 'https';
  host: string; // normalized: lowercased + Punycode + trailing-dot stripped
  port: number | null;
  origin: string; // "scheme://host[:port]"
  path: string;
  search: string;
}

// --------------------------------------------------------- redirect chain
export interface RedirectHop {
  url: string;
  status: number;
}

// --------------------------------------------------------- upstream raw
// What scrapling-fetcher returns (spec §0.2 contract additions).
export interface UpstreamFetchResult {
  status: number;
  html: string;
  next_data: unknown | null;
  headers: Record<string, string>;
  timing: { fetch_ms: number; total_ms: number };
  mode_used: FetchMode;
  bytes_in: number;
  bytes_out: number;
  proxy_bytes: number;
  browser_seconds: number;
  final_url: string;
  redirect_chain: RedirectHop[];
  // Screenshot extension (Phase 3c): present when caller passed
  // capture_screenshot=true; null otherwise.
  screenshot_png_b64: string | null;
  screenshot_width: number | null;
  screenshot_height: number | null;
}

// --------------------------------------------------------- scope context
// What the public-API runtime gives the route handler (spec §4.1).
export interface ApiKeyContext {
  id: string; // uuid
  prefix: string; // e.g. "gw_live_a1b2c3d4"
  scopes: string[];
  rateLimitRpm: number;
  writeRateLimitRpm: number;
}

// --------------------------------------------------------- envelope
export interface SuccessEnvelope<T> {
  data: T;
  meta: { request_id: string };
  billing?: BillingDeltas;
  warnings?: WarningEntry[];
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown> | null;
    retryable: boolean;
  };
  meta: { request_id: string };
}

export interface BillingDeltas {
  request_count_used: number;
  proxy_bytes_used: number;
  browser_seconds_used: number;
}

export interface WarningEntry {
  code: string;
  [k: string]: unknown;
}

// --------------------------------------------------------- audit row
export type BlockedBy =
  | 'instance_denylist'
  | 'instance_allowlist_violation'
  | 'key_denylist'
  | 'key_allowlist_violation'
  | 'final_url_domain_blocked'
  | 'robots'
  | 'quota';

export type BlockedStage = 'pre_fetch' | 'robots' | 'quota' | 'post_fetch';

export type ErrorClass =
  | 'upstream_timeout'
  | 'upstream_connection_error'
  | 'upstream_pool_full'
  | 'upstream_proxy_auth'
  | 'upstream_5xx_other'
  | 'unsupported_media_type'
  | 'extraction_timeout'
  | 'decode_invalid_bytes'
  | 'circuit_open'
  | 'internal_error';

export interface AuditStartInput {
  request_id: string;
  api_key_id: string;
  debit_id: string | null;
  requested_url: string;
  url_host: string;
  surface: Surface;
  mode: FetchMode;
  ignored_robots?: boolean;
  user_agent_used?: string | null;
  truncated_request?: Record<string, unknown> | null;
}

export interface AuditFinalizeInput {
  status: number;
  duration_ms?: number;
  bytes_in?: number;
  bytes_out?: number;
  proxy_bytes?: number;
  browser_seconds?: number;
  final_url?: string | null;
  final_url_host?: string | null;
  redirect_chain?: RedirectHop[] | null;
  blocked_by?: BlockedBy | null;
  blocked_stage?: BlockedStage | null;
  error_class?: ErrorClass | null;
  cost_usd_estimate?: number;
  proxy_provider?: string | null;
}

// --------------------------------------------------------- ledger
export type LedgerKind = 'debit' | 'reconcile' | 'refund' | 'adjustment';

export interface LedgerWrite {
  id: string; // ULID
  request_id: string;
  api_key_id: string;
  kind: LedgerKind;
  request_count_delta?: number;
  proxy_bytes_delta?: number;
  browser_seconds_delta?: number;
  cost_usd_estimate_delta?: number;
  reason?: string;
}

// --------------------------------------------------------- quotas
export type QuotaDimension = 'requests' | 'browser_seconds' | 'proxy_bytes';

export interface QuotaState {
  period_start: string; // RFC3339
  period_end: string;
  requests: { limit: number; used: number; remaining: number };
  browser_seconds: { limit: number; used: number; remaining: number };
  browser_minutes: { limit: number; used: number; remaining: number };
  proxy_bytes: { limit: number; used: number; remaining: number };
  proxy_gb: { limit: number; used: number; remaining: number };
  rate_per_minute: { limit: number };
}

// --------------------------------------------------------- domain
export interface DomainCheckResult {
  ok: true;
}
export interface DomainCheckBlocked {
  ok: false;
  rule: BlockedBy;
  pattern: string;
}
export type DomainDecision = DomainCheckResult | DomainCheckBlocked;

// --------------------------------------------------------- robots
export interface RobotsCheckResult {
  ok: boolean;
  disallowed_by?: string; // matching rule line
  user_agent?: string;
  robots_url?: string;
}

// --------------------------------------------------------- module config
// What we read from `mod.moduleConfig` at runtime (mirrors configSchema
// in index.ts; values are operator-provided overrides of defaults).
export interface ModuleSettings {
  enabled: boolean;
  default_quota_requests_per_month: number;
  default_quota_browser_minutes_per_month: number;
  default_quota_proxy_gb_per_month: number;
  instance_domain_denylist: string[];
  instance_domain_allowlist: string[];
  robots_cache_ttl_hours: number;
  robots_strict_on_5xx: boolean;
  robots_user_agent_template: string;
  robots_miss_rpm_per_key: number;
  robots_origins_per_day_global: number;
  cost_usd_per_request: number;
  cost_usd_per_browser_second: number;
  fetch_audit_redact_query_params: string[];
  response_inline_html_max_bytes: number;
  response_inline_markdown_max_bytes: number;
  storage_bucket_screenshots: string;
  storage_bucket_artifacts: string;
  idempotency_ttl_seconds: number;
  browser_seconds_reservation: number;
  signed_url_ttl_seconds: number;
}
