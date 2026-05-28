/**
 * Netlify API surface — minimal types for what this adapter touches.
 *
 * Auth: Bearer token; all calls go through https://api.netlify.com/api/v1.
 * Token must be a personal access token or app installation token with
 * `deploy` + `domains` scopes for the target site.
 *
 * Pure types — no fetch, no I/O.
 */

export const NETLIFY_API_BASE = 'https://api.netlify.com/api/v1';

/**
 * Secrets shape for the Netlify publisher. Stored encrypted in
 * sites_secrets and passed in only via the secrets argument (per spec
 * §9.0; secrets never reach the publisher via env or DATA_SOURCE config).
 */
export interface NetlifySecrets {
  /** Netlify API access token. */
  apiToken: string;
  /** Site id (UUID). Created out-of-band in the Netlify dashboard or via API. */
  siteId: string;
  /** Optional team / account slug — used by team-level cleanup APIs. */
  teamSlug?: string;
}

// ---------------------------------------------------------------------------
// Deploy (digest mode)
// ---------------------------------------------------------------------------
//
// Netlify uses a two-phase digest deploy:
//   1. POST /sites/{siteId}/deploys with `files: { "/path": "<sha1>" }`
//      → response includes `required: ["sha1-1", "sha1-2", ...]` listing
//        only the file shas Netlify doesn't already have
//   2. PUT /deploys/{deployId}/files/{relPath} for each required file
//      with `content-type: application/octet-stream` and the bytes as
//      the body
//
// IMPORTANT: Netlify hashes via SHA-1 (legacy), not SHA-256. The adapter
// computes a parallel SHA-1 manifest from the artifact's bytes; the
// platform's SHA-256 manifest stays authoritative for delta computation
// against PREVIOUS deploys, but Netlify's API only accepts SHA-1.

export interface NetlifyDeploy {
  id: string;
  site_id: string;
  /** 'new' / 'pending_review' / 'accepted' / 'rejected' / 'enqueued' / 'building' / 'uploading' / 'uploaded' / 'preparing' / 'prepared' / 'processing' / 'ready' / 'error'. */
  state: string;
  name: string;
  url: string;
  ssl_url: string;
  admin_url: string;
  deploy_url: string;     // unique-per-deploy preview URL
  deploy_ssl_url: string;
  /** SHA-1s of files Netlify needs us to upload. */
  required: ReadonlyArray<string>;
  required_functions?: ReadonlyArray<string>;
  created_at: string;
  updated_at: string;
  error_message?: string;
}

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export interface NetlifySiteDomainsResponse {
  /** Mirrors the `custom_domain` and `domain_aliases` columns on the site. */
  custom_domain: string | null;
  domain_aliases: ReadonlyArray<string>;
  /**
   * SSL state — Netlify provisions Let's Encrypt automatically once DNS
   * resolves to *.netlify.app. While provisioning the cert is 'provisioning'.
   */
  ssl: { state: string } | null;
}
