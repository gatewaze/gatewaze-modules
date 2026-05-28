/**
 * Cloudflare API surface — minimal types for what this adapter touches.
 *
 * Auth: every request goes through the v4 API at api.cloudflare.com with a
 * Bearer token. The token must be scoped to the account (Pages:Edit) and
 * the relevant zone (Cache:Purge) when domain-purge is needed.
 *
 * Pure types — no fetch, no I/O. The transport layer composes these with
 * the platform's HTTP client.
 */

export const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Common response envelope for Cloudflare's v4 API. */
export interface CloudflareEnvelope<T> {
  success: boolean;
  errors: ReadonlyArray<{ code: number; message: string }>;
  messages: ReadonlyArray<unknown>;
  result: T | null;
}

/**
 * Secrets shape for the Cloudflare Pages publisher. Stored encrypted in
 * sites_secrets and decrypted by the platform before passing in. Per spec
 * §9.0, secrets reach the publisher only via this argument — never via
 * env vars or DATA_SOURCE config.
 */
export interface CloudflareSecrets {
  /** Cloudflare API token with Pages:Edit + Zone:Cache Purge permissions. */
  apiToken: string;
  /** Cloudflare account id (32-char hex). */
  accountId: string;
  /** Pages project name (slug). Created out-of-band in the Cloudflare dashboard. */
  projectName: string;
  /** Zone id for the custom domain. Required for cache invalidation. */
  zoneId?: string;
  /** Production branch name. Defaults to 'main' if absent. */
  productionBranch?: string;
}

// ---------------------------------------------------------------------------
// Pages deployment
// ---------------------------------------------------------------------------

export interface PagesDeployment {
  id: string;
  url: string;                            // e.g. https://abc123.example.pages.dev
  environment: 'production' | 'preview';
  created_on: string;
  short_id: string;
  project_id: string;
  project_name: string;
  deployment_trigger: { type: string };
  /**
   * Latest stage's status. Cloudflare's stages array ends with 'deploy';
   * we project its `status` to a top-level shape. 'success' / 'failure' /
   * 'active' / 'idle' / 'canceled'.
   */
  latest_stage: { name: string; status: string; ended_on: string | null };
  aliases?: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Pages domain
// ---------------------------------------------------------------------------

export interface PagesDomain {
  id: string;
  name: string;
  /** 'pending' / 'active' / 'verification_failed' / 'deactivated' */
  status: string;
  /** Verification status data — present when Cloudflare needs DNS verification. */
  verification_data?: {
    status: 'success' | 'pending' | 'failure';
    error?: string;
  };
  validation_data?: {
    status: 'success' | 'pending' | 'failure' | 'active';
    method?: 'http' | 'txt';
  };
  /**
   * For the apex/root, Cloudflare may instruct the user to add an A or
   * AAAA record. For subdomains, a CNAME. Cloudflare doesn't return DNS
   * instructions in the API directly — we synthesize them in the adapter.
   */
}
