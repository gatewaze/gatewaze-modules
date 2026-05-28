/**
 * Netlify adapter — implements IExternalPublisher.
 *
 * Composition over lib/api: pure request shapers + parsers, transport via
 * an injected fetch (so tests run without a real network).
 *
 * Notable design choices:
 *
 *   - Netlify uses SHA-1 for content addressing (legacy). We compute a
 *     parallel SHA-1 manifest at deploy time; the platform's SHA-256
 *     manifest stays authoritative for delta computation against the
 *     PREVIOUS deploy state.
 *   - syncMedia returns 'inline-in-artifact' — like Cloudflare, Netlify
 *     publishes media files directly through the deploy API.
 *   - invalidateCache is best-effort: Netlify lacks a granular per-path
 *     purge, so we trigger a no-op build to bump the published deploy.
 *     For zero-impact cache invalidation, sites should opt in to the
 *     X-Cache-Tag header pattern — out of scope for v0.1.
 *   - Domain registration is `PATCH /sites/{id}` swapping
 *     custom_domain + domain_aliases atomically. Netlify auto-provisions
 *     Let's Encrypt SSL; we trigger /ssl explicitly to short-circuit
 *     polling.
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
  getSiteRequest,
  updateSiteDomainsRequest,
  provisionSslRequest,
  triggerBuildRequest,
  deploymentStatusFromState,
  dnsInstructionsForDomain,
  buildSha1Manifest,
  type NetlifySecrets,
  type NlRequest,
  type NetlifyDeploy,
  type NetlifySiteDomainsResponse,
} from './lib/api/index.js';

export type FetchLike = (input: { url: string; method: string; headers: Record<string, string>; body: unknown }) => Promise<{
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface NetlifyAdapterDeps {
  fetch: FetchLike;
  /** Read a file's bytes from the artifact directory. */
  readArtifactFile: (artifactDir: string, relPath: string) => Promise<Uint8Array>;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

interface SiteResponse {
  name: string;
  custom_domain: string | null;
  domain_aliases: ReadonlyArray<string>;
  ssl: { state: string } | null;
}

export class NetlifyPublisher implements IExternalPublisher {
  constructor(private readonly deps: NetlifyAdapterDeps) {}

  validateConfig(secrets: PublisherSecrets): ValidationResult {
    const r = validateSecrets(secrets);
    return { ok: r.ok, errors: r.errors };
  }

  async prepareArtifact(
    artifact: BuildArtifact,
    _secrets: PublisherSecrets,
  ): Promise<{ writtenFiles: ReadonlyArray<{ relPath: string; bytes: number }> }> {
    // No-op: the renderer has already written files to artifactDir.
    return {
      writtenFiles: artifact.fileManifest.map((e) => ({ relPath: e.relPath, bytes: e.size })),
    };
  }

  async deploy(artifact: BuildArtifact, secrets: PublisherSecrets): Promise<DeploymentResult> {
    const nlSecrets = this.assertNlSecrets(secrets);
    const startedAt = Date.now();

    // 1. Read all bytes once, hash them with SHA-1, build the digest.
    const entries = await Promise.all(
      artifact.fileManifest.map(async (e) => ({
        relPath: e.relPath,
        bytes: await this.deps.readArtifactFile(artifact.artifactDir, e.relPath),
      })),
    );
    const sha1Manifest = await buildSha1Manifest(entries);

    // 2. POST the manifest. Netlify replies with `required: [sha1, sha1, …]`
    //    listing only the files it doesn't already have on disk.
    const create = await this.send<NetlifyDeploy>(
      createDeploymentRequest({ secrets: nlSecrets, files: sha1Manifest.files }),
    );

    // 3. Upload required files (those whose SHA-1 is in `required`).
    const requiredSet = new Set(create.required);
    for (const m of sha1Manifest.entries) {
      if (!requiredSet.has(m.sha1)) continue;
      const matching = entries.find((e) => e.relPath === m.relPath);
      if (!matching) {
        throw new Error(`netlify_upload_inconsistency: required ${m.sha1} but no entry for ${m.relPath}`);
      }
      await this.send(uploadFileRequest({
        secrets: nlSecrets, deployId: create.id,
        relPath: m.relPath,
        bytes: matching.bytes,
      }));
    }

    return {
      publicUrl: create.ssl_url || create.url,
      deployId: create.id,
      // Netlify's CDN domains aren't returned per-deploy; the platform
      // surfaces them from sites.publishing_target metadata.
      cdnDomains: [],
      durationMs: Date.now() - startedAt,
    };
  }

  async deployPreview(
    artifact: BuildArtifact,
    page: { id: string; fullPath: string },
    secrets: PublisherSecrets,
  ): Promise<PreviewResult> {
    const nlSecrets = this.assertNlSecrets(secrets);

    const entries = await Promise.all(
      artifact.fileManifest.map(async (e) => ({
        relPath: e.relPath,
        bytes: await this.deps.readArtifactFile(artifact.artifactDir, e.relPath),
      })),
    );
    const sha1Manifest = await buildSha1Manifest(entries);

    // draft=true → unique deploy_url, not promoted to production.
    const create = await this.send<NetlifyDeploy>(
      createDeploymentRequest({ secrets: nlSecrets, files: sha1Manifest.files, draft: true }),
    );
    const requiredSet = new Set(create.required);
    for (const m of sha1Manifest.entries) {
      if (!requiredSet.has(m.sha1)) continue;
      const matching = entries.find((e) => e.relPath === m.relPath);
      if (!matching) continue;
      await this.send(uploadFileRequest({
        secrets: nlSecrets, deployId: create.id,
        relPath: m.relPath, bytes: matching.bytes,
      }));
    }

    return {
      previewUrl: `${create.deploy_ssl_url || create.deploy_url}${page.fullPath}`,
      deployId: create.id,
    };
  }

  async invalidateCache(secrets: PublisherSecrets, paths: string[]): Promise<void> {
    const nlSecrets = this.assertNlSecrets(secrets);
    void paths;
    // Netlify lacks a granular per-path purge. Trigger a no-op build to
    // re-publish; this nudges Netlify's edge cache.
    await this.send(triggerBuildRequest({ secrets: nlSecrets }));
  }

  async syncMedia(
    _siteId: string,
    _mediaRefs: ReadonlyArray<MediaRef>,
    _secrets: PublisherSecrets,
  ): Promise<MediaSyncResult> {
    return { mode: 'inline-in-artifact', bytesSynced: 0 };
  }

  async cleanupExpiredPreviews(_secrets: PublisherSecrets, _olderThanHours: number): Promise<number> {
    // Netlify auto-prunes draft deploys via its retention policy on each
    // production tier; the platform sweeper isn't responsible for it.
    return 0;
  }

  async addDomain(domain: string, secrets: PublisherSecrets): Promise<DomainAddedResult> {
    const nlSecrets = this.assertNlSecrets(secrets);
    // Read the current site to know whether to set custom_domain or add to aliases.
    const site = await this.send<SiteResponse>(getSiteRequest({ secrets: nlSecrets }));
    const aliases = site.domain_aliases ?? [];
    if (!site.custom_domain) {
      await this.send(updateSiteDomainsRequest({ secrets: nlSecrets, custom_domain: domain }));
    } else if (!aliases.includes(domain) && site.custom_domain !== domain) {
      await this.send(updateSiteDomainsRequest({
        secrets: nlSecrets,
        domain_aliases: [...aliases, domain],
      }));
    }
    // Trigger SSL provisioning eagerly (idempotent).
    await this.send(provisionSslRequest({ secrets: nlSecrets })).catch(() => {/* tolerate races */});

    const dnsInstructions = dnsInstructionsForDomain({ secrets: nlSecrets, domain, siteName: site.name });
    return { dnsInstructions };
  }

  async getDomainStatus(domain: string, secrets: PublisherSecrets): Promise<DomainStatusResult> {
    const nlSecrets = this.assertNlSecrets(secrets);
    const site = await this.send<SiteResponse>(getSiteRequest({ secrets: nlSecrets }));
    const isAttached = site.custom_domain === domain || site.domain_aliases?.includes(domain);
    if (!isAttached) {
      return { state: 'pending_dns', attempted_at: new Date().toISOString() };
    }
    const sslState = site.ssl?.state ?? null;
    const state: ExternalDomainState =
      sslState === 'verified' || sslState === 'live' || sslState === 'active' ? 'verified'
        : sslState === 'provisioning' || sslState === 'pending' ? 'pending_verification'
          : sslState === 'error' || sslState === 'invalid' ? 'misconfigured'
            : 'pending_verification';
    return {
      state,
      attempted_at: new Date().toISOString(),
      ...(sslState ? { details: `ssl=${sslState}` } : {}),
    };
  }

  async removeDomain(domain: string, secrets: PublisherSecrets): Promise<void> {
    const nlSecrets = this.assertNlSecrets(secrets);
    const site = await this.send<SiteResponse>(getSiteRequest({ secrets: nlSecrets }));
    if (site.custom_domain === domain) {
      await this.send(updateSiteDomainsRequest({ secrets: nlSecrets, custom_domain: null }));
    } else if (site.domain_aliases?.includes(domain)) {
      await this.send(updateSiteDomainsRequest({
        secrets: nlSecrets,
        domain_aliases: site.domain_aliases.filter((d) => d !== domain),
      }));
    }
  }

  async getDeploymentStatus(deployId: string, secrets: PublisherSecrets): Promise<DeploymentStatusResult> {
    const nlSecrets = this.assertNlSecrets(secrets);
    const resp = await this.send<NetlifyDeploy | null>(getDeploymentRequest({ secrets: nlSecrets, deployId })).catch(() => null);
    if (!resp) return { state: 'unknown' };
    const result: DeploymentStatusResult = {
      state: deploymentStatusFromState(resp.state),
    };
    if (resp.ssl_url || resp.url) {
      result.public_url = resp.ssl_url || resp.url;
    }
    if (resp.error_message) {
      result.error = resp.error_message;
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private assertNlSecrets(secrets: PublisherSecrets): NetlifySecrets {
    const r = validateSecrets(secrets);
    if (!r.ok || !r.value) {
      throw new Error(`invalid_secrets: ${r.errors.map((e) => `${e.path}:${e.message}`).join(',')}`);
    }
    return r.value;
  }

  private async send<T>(req: NlRequest): Promise<T> {
    const res = await this.deps.fetch({
      url: req.url, method: req.method, headers: req.headers, body: req.body,
    });
    if (res.status === 404) throw new Error('netlify_resource_not_found');
    if (res.status >= 400) {
      const txt = await res.text().catch(() => '');
      throw new Error(`netlify_api_error: ${res.status} ${txt}`);
    }
    if (res.status === 204) return null as T;
    return await res.json() as T;
  }
}

// Export the NetlifySiteDomainsResponse type-only so tests don't pull it
// transitively when the adapter doesn't need to project it.
export type { NetlifySiteDomainsResponse };
