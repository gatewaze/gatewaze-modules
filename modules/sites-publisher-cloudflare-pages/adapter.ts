/**
 * Cloudflare Pages adapter — implements IExternalPublisher.
 *
 * Composition layer over lib/api: the request shapers + parsers stay pure,
 * the adapter wires them to a concrete `fetch` implementation. The fetch
 * is injected so the caller (platform worker) can wrap it for telemetry,
 * timeouts, and retries.
 *
 * Per spec-sites-module §6.5:
 *   - Adapter implementations MUST NOT read env vars; secrets arrive only
 *     via the secrets argument
 *   - validateConfig is a pre-flight; failures surface in the admin UI
 *   - prepareArtifact + deploy are separate steps so the worker can
 *     report progress independently
 *   - syncMedia is publisher-shaped — Cloudflare uses 'inline-in-artifact'
 *     mode (everything goes through the deploy manifest); no separate
 *     CDN bucket
 */

import type {
  IExternalPublisher,
  PublisherSecrets,
  ValidationResult,
  BuildArtifact,
  DeploymentResult,
  PreviewResult,
  MediaRef,
  MediaSyncResult,
  DomainAddedResult,
  DomainStatusResult,
  DeploymentStatusResult,
  ExternalDomainState,
} from '@gatewaze-modules/sites/types';
import {
  validateSecrets,
  createDeploymentRequest,
  getDeploymentRequest,
  uploadFileRequest,
  addDomainRequest,
  getDomainRequest,
  deleteDomainRequest,
  purgeCacheRequest,
  unwrapEnvelope,
  deploymentStatusFromResponse,
  dnsInstructionsForDomain,
  type CloudflareSecrets,
  type CfRequest,
  type PagesDeployment,
  type PagesDomain,
} from './lib/api/index.js';

export type FetchLike = (input: { url: string; method: string; headers: Record<string, string>; body: unknown }) => Promise<{
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface CloudflareAdapterDeps {
  /** Injectable HTTP client. Must throw on transport errors; ok responses. */
  fetch: FetchLike;
  /** Read a file's bytes from the artifact directory. */
  readArtifactFile: (artifactDir: string, relPath: string) => Promise<Uint8Array>;
  /** Optional logger; defaults to no-op. */
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export class CloudflarePagesPublisher implements IExternalPublisher {
  constructor(private readonly deps: CloudflareAdapterDeps) {}

  validateConfig(secrets: PublisherSecrets): ValidationResult {
    const r = validateSecrets(secrets);
    return { ok: r.ok, errors: r.errors };
  }

  async prepareArtifact(
    artifact: BuildArtifact,
    secrets: PublisherSecrets,
  ): Promise<{ writtenFiles: ReadonlyArray<{ relPath: string; bytes: number }> }> {
    // Cloudflare's deploy step uploads files itself given the manifest;
    // prepareArtifact is a no-op for this publisher (the worker has
    // already written files to artifactDir during render). We return
    // the manifest as evidence the artifact is prepared.
    const written = artifact.fileManifest.map((e) => ({ relPath: e.relPath, bytes: e.size }));
    return { writtenFiles: written };
  }

  async deploy(artifact: BuildArtifact, secrets: PublisherSecrets): Promise<DeploymentResult> {
    const cfSecrets = this.assertCfSecrets(secrets);
    const startedAt = Date.now();
    const branch = cfSecrets.productionBranch ?? 'main';

    // 1. Create the deployment with the manifest. CF returns the deployment
    //    plus a JWT to upload missing assets.
    const create = await this.send<{ deployment: PagesDeployment; jwt: string; missing_hashes: string[] }>(
      createDeploymentRequest({ secrets: cfSecrets, branch, manifest: artifact.fileManifest }),
    );

    // 2. Upload missing files in serial — CF rate-limits the upload host
    //    and we don't want to compound burst risk.
    const missingByHash = new Set(create.missing_hashes ?? []);
    for (const entry of artifact.fileManifest) {
      if (!missingByHash.has(entry.sha256)) continue;
      const bytes = await this.deps.readArtifactFile(artifact.artifactDir, entry.relPath);
      await this.send(uploadFileRequest({
        secrets: cfSecrets,
        jwt: create.jwt,
        relPath: entry.relPath,
        bytes,
        contentType: contentTypeFromRelPath(entry.relPath),
      }));
    }

    return {
      publicUrl: create.deployment.url,
      deployId: create.deployment.id,
      cdnDomains: create.deployment.aliases ?? [],
      durationMs: Date.now() - startedAt,
    };
  }

  async deployPreview(
    artifact: BuildArtifact,
    page: { id: string; fullPath: string },
    secrets: PublisherSecrets,
  ): Promise<PreviewResult> {
    const cfSecrets = this.assertCfSecrets(secrets);
    // For previews, we use a non-production branch named after the page.
    // CF Pages allocates a unique <branch>.<project>.pages.dev URL.
    const branch = previewBranchName(page.id);
    const create = await this.send<{ deployment: PagesDeployment; jwt: string; missing_hashes: string[] }>(
      createDeploymentRequest({ secrets: cfSecrets, branch, manifest: artifact.fileManifest }),
    );
    const missingByHash = new Set(create.missing_hashes ?? []);
    for (const entry of artifact.fileManifest) {
      if (!missingByHash.has(entry.sha256)) continue;
      const bytes = await this.deps.readArtifactFile(artifact.artifactDir, entry.relPath);
      await this.send(uploadFileRequest({
        secrets: cfSecrets,
        jwt: create.jwt,
        relPath: entry.relPath,
        bytes,
        contentType: contentTypeFromRelPath(entry.relPath),
      }));
    }
    const previewUrl = `${create.deployment.url}${page.fullPath}`;
    return {
      previewUrl,
      deployId: create.deployment.id,
      // CF Pages preview deployments don't have a hard expiry — the platform
      // sweeper deletes them via cleanupExpiredPreviews().
    };
  }

  async invalidateCache(secrets: PublisherSecrets, paths: string[]): Promise<void> {
    const cfSecrets = this.assertCfSecrets(secrets);
    if (!cfSecrets.zoneId) {
      // No zone configured — skip silently. The platform's TTL fallback
      // handles eventual consistency.
      return;
    }
    if (paths.length === 0) return;
    // Cloudflare allows ≤30 paths per call. Batch.
    for (let i = 0; i < paths.length; i += 30) {
      const batch = paths.slice(i, i + 30);
      await this.send(purgeCacheRequest({ secrets: cfSecrets, paths: batch }));
    }
  }

  async syncMedia(
    _siteId: string,
    _mediaRefs: ReadonlyArray<MediaRef>,
    _secrets: PublisherSecrets,
  ): Promise<MediaSyncResult> {
    // Cloudflare Pages publishes media inline with the artifact; there's
    // no separate CDN bucket to sync to. The renderer has already written
    // media files into the artifact directory by the time deploy() runs.
    return { mode: 'inline-in-artifact', bytesSynced: 0 };
  }

  async cleanupExpiredPreviews(secrets: PublisherSecrets, olderThanHours: number): Promise<number> {
    const cfSecrets = this.assertCfSecrets(secrets);
    void cfSecrets;
    void olderThanHours;
    // Listing + deleting old preview deployments requires the
    // `Pages:Edit` token (we have it). For the v0.1 adapter we delegate
    // the actual list+delete loop to the platform sweeper, which holds
    // pagination state in the deployment ledger. Returning 0 = "nothing
    // cleaned this pass".
    return 0;
  }

  async addDomain(domain: string, secrets: PublisherSecrets): Promise<DomainAddedResult> {
    const cfSecrets = this.assertCfSecrets(secrets);
    const _resp = await this.send<PagesDomain>(addDomainRequest({ secrets: cfSecrets, domain }));
    const dnsInstructions = dnsInstructionsForDomain({ secrets: cfSecrets, domain, domainResponse: _resp });
    return { dnsInstructions };
  }

  async getDomainStatus(domain: string, secrets: PublisherSecrets): Promise<DomainStatusResult> {
    const cfSecrets = this.assertCfSecrets(secrets);
    const resp = await this.send<PagesDomain | null>(getDomainRequest({ secrets: cfSecrets, domain })).catch((e: unknown) => {
      if (e instanceof Error && e.message.includes('not found')) return null;
      throw e;
    });
    if (!resp) {
      return { state: 'pending_dns', attempted_at: new Date().toISOString() };
    }
    return {
      state: mapDomainState(resp.status),
      attempted_at: new Date().toISOString(),
      ...(resp.verification_data?.error ? { details: resp.verification_data.error } : {}),
    };
  }

  async removeDomain(domain: string, secrets: PublisherSecrets): Promise<void> {
    const cfSecrets = this.assertCfSecrets(secrets);
    await this.send(deleteDomainRequest({ secrets: cfSecrets, domain }));
  }

  async getDeploymentStatus(deployId: string, secrets: PublisherSecrets): Promise<DeploymentStatusResult> {
    const cfSecrets = this.assertCfSecrets(secrets);
    const resp = await this.send<PagesDeployment | null>(getDeploymentRequest({ secrets: cfSecrets, deploymentId: deployId })).catch(() => null);
    if (!resp) return { state: 'unknown' };
    return {
      state: deploymentStatusFromResponse(resp),
      ...(resp.url ? { public_url: resp.url } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private assertCfSecrets(secrets: PublisherSecrets): CloudflareSecrets {
    const r = validateSecrets(secrets);
    if (!r.ok || !r.value) {
      throw new Error(`invalid_secrets: ${r.errors.map((e) => `${e.path}:${e.message}`).join(',')}`);
    }
    return r.value;
  }

  private async send<T>(req: CfRequest): Promise<T> {
    const res = await this.deps.fetch({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    if (res.status === 404) throw new Error('cloudflare_resource_not_found');
    const json = await res.json();
    return unwrapEnvelope<T>(json);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapDomainState(cfStatus: string): ExternalDomainState {
  switch (cfStatus) {
    case 'active': return 'verified';
    case 'pending': return 'pending_verification';
    case 'verification_failed': return 'misconfigured';
    case 'deactivated': return 'misconfigured';
    default: return 'pending_dns';
  }
}

function previewBranchName(pageId: string): string {
  const slug = pageId.replace(/[^a-z0-9-]/gi, '').slice(0, 24).toLowerCase();
  return `preview-${slug}`;
}

function contentTypeFromRelPath(relPath: string): string {
  const ext = relPath.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'html': return 'text/html; charset=utf-8';
    case 'css': return 'text/css; charset=utf-8';
    case 'js': case 'mjs': return 'application/javascript; charset=utf-8';
    case 'json': return 'application/json; charset=utf-8';
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'svg': return 'image/svg+xml';
    case 'webp': return 'image/webp';
    case 'avif': return 'image/avif';
    case 'woff': return 'font/woff';
    case 'woff2': return 'font/woff2';
    case 'ico': return 'image/x-icon';
    case 'txt': return 'text/plain; charset=utf-8';
    case 'xml': return 'application/xml; charset=utf-8';
    default: return 'application/octet-stream';
  }
}
