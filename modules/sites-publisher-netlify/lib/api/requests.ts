/**
 * Pure request shapers for the Netlify v1 API.
 *
 * Netlify's deploy flow is a two-phase digest exchange:
 *   1. createDeploymentRequest → server replies with `required: [<sha1>...]`
 *   2. uploadFileRequest for each required path
 *
 * Domain management uses the site PUT endpoint to swap `custom_domain`
 * and `domain_aliases` arrays atomically.
 */

import { NETLIFY_API_BASE, type NetlifySecrets } from './types.js';

export interface NlRequest {
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function authHeaders(secrets: NetlifySecrets): Record<string, string> {
  return {
    authorization: `Bearer ${secrets.apiToken}`,
    accept: 'application/json',
  };
}

// ---------------------------------------------------------------------------
// Deployments — digest mode
// ---------------------------------------------------------------------------

/**
 * Phase 1: create the deploy with a SHA-1 manifest. Netlify returns the
 * deploy id + `required` list of sha1s we still need to upload.
 *
 * Netlify uses /-prefixed paths; same convention as Cloudflare.
 */
export function createDeploymentRequest(args: {
  secrets: NetlifySecrets;
  /** Map of "/path/to/file" → "<sha1 hex>". */
  files: Record<string, string>;
  draft?: boolean;
}): NlRequest {
  const body: Record<string, unknown> = { files: args.files };
  if (args.draft) body['draft'] = true;
  return {
    method: 'POST',
    url: `${NETLIFY_API_BASE}/sites/${args.secrets.siteId}/deploys`,
    headers: { ...authHeaders(args.secrets), 'content-type': 'application/json' },
    body,
  };
}

export function getDeploymentRequest(args: {
  secrets: NetlifySecrets;
  deployId: string;
}): NlRequest {
  return {
    method: 'GET',
    url: `${NETLIFY_API_BASE}/sites/${args.secrets.siteId}/deploys/${args.deployId}`,
    headers: authHeaders(args.secrets),
    body: null,
  };
}

/**
 * Phase 2: PUT each required file. Path includes the leading '/'; the
 * server matches against the SHA-1s it expects.
 */
export function uploadFileRequest(args: {
  secrets: NetlifySecrets;
  deployId: string;
  relPath: string;        // without leading '/'
  bytes: Uint8Array;
}): NlRequest {
  return {
    method: 'PUT',
    url: `${NETLIFY_API_BASE}/deploys/${args.deployId}/files/${encodePath(args.relPath)}`,
    headers: { ...authHeaders(args.secrets), 'content-type': 'application/octet-stream' },
    body: args.bytes,
  };
}

// ---------------------------------------------------------------------------
// Domain management — read/update via the site endpoint
// ---------------------------------------------------------------------------

export function getSiteRequest(args: { secrets: NetlifySecrets }): NlRequest {
  return {
    method: 'GET',
    url: `${NETLIFY_API_BASE}/sites/${args.secrets.siteId}`,
    headers: authHeaders(args.secrets),
    body: null,
  };
}

export function updateSiteDomainsRequest(args: {
  secrets: NetlifySecrets;
  custom_domain?: string | null;
  domain_aliases?: ReadonlyArray<string>;
}): NlRequest {
  const body: Record<string, unknown> = {};
  if (args.custom_domain !== undefined) body['custom_domain'] = args.custom_domain;
  if (args.domain_aliases !== undefined) body['domain_aliases'] = args.domain_aliases;
  return {
    method: 'PATCH',
    url: `${NETLIFY_API_BASE}/sites/${args.secrets.siteId}`,
    headers: { ...authHeaders(args.secrets), 'content-type': 'application/json' },
    body,
  };
}

/** Trigger SSL provisioning after DNS has been pointed. */
export function provisionSslRequest(args: { secrets: NetlifySecrets }): NlRequest {
  return {
    method: 'POST',
    url: `${NETLIFY_API_BASE}/sites/${args.secrets.siteId}/ssl`,
    headers: authHeaders(args.secrets),
    body: null,
  };
}

// ---------------------------------------------------------------------------
// Cache — Netlify lacks a granular per-path purge; we trigger a no-op
// build that re-publishes the same deploy.
// ---------------------------------------------------------------------------

export function triggerBuildRequest(args: { secrets: NetlifySecrets }): NlRequest {
  return {
    method: 'POST',
    url: `${NETLIFY_API_BASE}/sites/${args.secrets.siteId}/builds`,
    headers: authHeaders(args.secrets),
    body: null,
  };
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** Map Netlify's deploy state to the platform's DeploymentStatusResult.state. */
export function deploymentStatusFromState(state: string): 'live' | 'building' | 'failed' | 'unknown' {
  if (state === 'ready') return 'live';
  if (state === 'error' || state === 'rejected') return 'failed';
  if (
    state === 'enqueued' || state === 'building' || state === 'uploading' ||
    state === 'uploaded' || state === 'preparing' || state === 'prepared' ||
    state === 'processing' || state === 'new' || state === 'pending_review'
  ) {
    return 'building';
  }
  return 'unknown';
}

/**
 * Synthesize DNS instructions for a custom domain. Per Netlify docs,
 * the canonical pattern is:
 *   - Apex → A record to Netlify load balancer
 *   - Subdomain → CNAME to <site-name>.netlify.app
 *
 * Netlify's actual A-record IP rotates; the documented public load balancer
 * is 75.2.60.5 (announced via Netlify docs). We default to that and let
 * the platform sweeper override per-environment if needed.
 */
export function dnsInstructionsForDomain(args: {
  secrets: NetlifySecrets;
  domain: string;
  /** The site's `name` field (e.g., 'example-prod') — used to construct the CNAME target. */
  siteName: string;
}): ReadonlyArray<{ record_type: 'A' | 'AAAA' | 'CNAME' | 'TXT'; host: string; value: string; ttl?: number }> {
  const isApex = args.domain.split('.').length === 2;
  if (isApex) {
    return [
      { record_type: 'A', host: args.domain, value: '75.2.60.5', ttl: 300 },
    ];
  }
  return [
    { record_type: 'CNAME', host: args.domain, value: `${args.siteName}.netlify.app`, ttl: 300 },
  ];
}

function encodePath(relPath: string): string {
  // Encode each path segment but preserve the slashes.
  return relPath.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}
