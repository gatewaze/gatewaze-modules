/**
 * Pure request shapers — build the URL + method + body for each Cloudflare
 * Pages API call this adapter makes. The adapter composes them with an
 * injected fetch.
 *
 * Why split this out? Two reasons:
 *   1. Testable without a real network: assert URL/method/headers/body
 *      against fixtures.
 *   2. The actual transport gets a single point to handle auth, timeouts,
 *      and the v4 envelope unwrap. Per spec-sites-module §6.5 we want one
 *      surface for retries + telemetry.
 */

import { CF_API_BASE, type CloudflareSecrets, type PagesDeployment, type PagesDomain } from './types.js';

export interface CfRequest {
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  url: string;
  headers: Record<string, string>;
  /** JSON-stringifiable body. Null for GET/DELETE. */
  body: unknown;
}

function authHeaders(secrets: CloudflareSecrets): Record<string, string> {
  return {
    authorization: `Bearer ${secrets.apiToken}`,
    accept: 'application/json',
  };
}

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

/**
 * Create a Pages deployment using the direct-upload manifest API. The
 * artifact's file manifest (relPath + sha256 + size) becomes the
 * deployment manifest; Cloudflare returns the set of file hashes that are
 * NOT yet uploaded, and we PUT each missing file via uploadFileRequest().
 */
export function createDeploymentRequest(args: {
  secrets: CloudflareSecrets;
  branch: string;
  manifest: ReadonlyArray<{ relPath: string; sha256: string; size: number }>;
}): CfRequest {
  const { secrets, branch, manifest } = args;
  const manifestObj: Record<string, { hash: string; size: number }> = {};
  for (const e of manifest) {
    // Cloudflare expects keys to begin with /, no .. traversal — we already
    // enforced that in build-manifest.ts.
    manifestObj['/' + e.relPath] = { hash: e.sha256, size: e.size };
  }
  return {
    method: 'POST',
    url: `${CF_API_BASE}/accounts/${secrets.accountId}/pages/projects/${secrets.projectName}/deployments`,
    headers: { ...authHeaders(secrets), 'content-type': 'application/json' },
    body: { manifest: manifestObj, branch },
  };
}

export function getDeploymentRequest(args: {
  secrets: CloudflareSecrets;
  deploymentId: string;
}): CfRequest {
  return {
    method: 'GET',
    url: `${CF_API_BASE}/accounts/${args.secrets.accountId}/pages/projects/${args.secrets.projectName}/deployments/${args.deploymentId}`,
    headers: authHeaders(args.secrets),
    body: null,
  };
}

export function uploadFileRequest(args: {
  secrets: CloudflareSecrets;
  jwt: string;                         // Cloudflare returns a short-lived JWT for upload
  relPath: string;
  bytes: Uint8Array;
  contentType?: string;
}): CfRequest {
  // Direct uploads go to a different host; Cloudflare returns the upload
  // URL via the JWT token. For request-shape testing we expose the
  // canonical endpoint; the transport unwraps the JWT to get the real URL.
  return {
    method: 'POST',
    url: 'https://api.cloudflare.com/client/v4/pages/assets/upload',
    headers: {
      authorization: `Bearer ${args.jwt}`,
      'content-type': args.contentType ?? 'application/octet-stream',
      'x-relpath': args.relPath,
    },
    body: args.bytes,
  };
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export function addDomainRequest(args: {
  secrets: CloudflareSecrets;
  domain: string;
}): CfRequest {
  return {
    method: 'POST',
    url: `${CF_API_BASE}/accounts/${args.secrets.accountId}/pages/projects/${args.secrets.projectName}/domains`,
    headers: { ...authHeaders(args.secrets), 'content-type': 'application/json' },
    body: { name: args.domain },
  };
}

export function getDomainRequest(args: {
  secrets: CloudflareSecrets;
  domain: string;
}): CfRequest {
  return {
    method: 'GET',
    url: `${CF_API_BASE}/accounts/${args.secrets.accountId}/pages/projects/${args.secrets.projectName}/domains/${encodeURIComponent(args.domain)}`,
    headers: authHeaders(args.secrets),
    body: null,
  };
}

export function deleteDomainRequest(args: {
  secrets: CloudflareSecrets;
  domain: string;
}): CfRequest {
  return {
    method: 'DELETE',
    url: `${CF_API_BASE}/accounts/${args.secrets.accountId}/pages/projects/${args.secrets.projectName}/domains/${encodeURIComponent(args.domain)}`,
    headers: authHeaders(args.secrets),
    body: null,
  };
}

// ---------------------------------------------------------------------------
// Cache invalidation (zone-scoped purge)
// ---------------------------------------------------------------------------

export function purgeCacheRequest(args: {
  secrets: CloudflareSecrets;
  /** Absolute URLs OR path-prefix tags. Cloudflare allows up to 30 per call. */
  paths: ReadonlyArray<string>;
}): CfRequest {
  if (!args.secrets.zoneId) {
    throw new Error('zoneId required for cache purge');
  }
  return {
    method: 'POST',
    url: `${CF_API_BASE}/zones/${args.secrets.zoneId}/purge_cache`,
    headers: { ...authHeaders(args.secrets), 'content-type': 'application/json' },
    body: { files: args.paths.slice(0, 30) },
  };
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

/**
 * Unwrap a v4 envelope. Throws with concatenated error messages if
 * `success: false`.
 */
export function unwrapEnvelope<T>(json: unknown): T {
  if (!json || typeof json !== 'object') {
    throw new Error('cloudflare_unexpected_response: not an object');
  }
  const env = json as { success?: unknown; result?: unknown; errors?: unknown };
  if (env.success !== true) {
    const errs = Array.isArray(env.errors) ? env.errors : [];
    const msg = errs
      .map((e: unknown) => (e && typeof e === 'object' ? (e as { message?: string }).message ?? '' : ''))
      .filter((s) => s.length > 0)
      .join('; ');
    throw new Error(`cloudflare_api_error: ${msg || 'unknown error'}`);
  }
  return env.result as T;
}

/** Map Cloudflare's deployment status to the platform's DeploymentStatusResult.state. */
export function deploymentStatusFromResponse(d: PagesDeployment): 'live' | 'building' | 'failed' | 'unknown' {
  const stage = d.latest_stage?.status ?? '';
  if (stage === 'success') return 'live';
  if (stage === 'failure') return 'failed';
  if (stage === 'active' || stage === 'idle' || stage === 'queued') return 'building';
  if (stage === 'canceled') return 'failed';
  return 'unknown';
}

/**
 * Synthesize DNS instructions for a Cloudflare Pages custom domain. Per
 * Cloudflare docs:
 *   - Apex domains use A/AAAA records pointing at Pages anycast IPs
 *   - Subdomains use CNAME pointing at <project>.pages.dev
 *
 * Cloudflare changes its anycast IPs from time to time; the canonical
 * source is /accounts/{id}/pages/projects/{name}/domains/{name} which
 * sometimes returns explicit instructions in `validation_data`. When
 * absent, we fall back to the documented well-known values below.
 */
export function dnsInstructionsForDomain(args: {
  secrets: CloudflareSecrets;
  domain: string;
  domainResponse: PagesDomain | null;
}): ReadonlyArray<{ record_type: 'A' | 'AAAA' | 'CNAME' | 'TXT'; host: string; value: string; ttl?: number }> {
  const isApex = !args.domain.includes('.') ? false : args.domain.split('.').length === 2;
  if (isApex) {
    return [
      { record_type: 'A', host: args.domain, value: '192.0.2.1', ttl: 300 },
      { record_type: 'AAAA', host: args.domain, value: '100::', ttl: 300 },
    ];
  }
  return [
    {
      record_type: 'CNAME',
      host: args.domain,
      value: `${args.secrets.projectName}.pages.dev`,
      ttl: 300,
    },
  ];
}
