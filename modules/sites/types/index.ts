/**
 * Sites module — public types.
 *
 * Row shapes mirror migration 001 / 002 columns.
 */

// ----------------------------------------------------------------------------
// Sites
// ----------------------------------------------------------------------------

export type SiteStatus = 'active' | 'archived';

/**
 * Discriminator added by spec-sites-theme-kinds annex. Inherited from the
 * site's library (via templates_libraries.theme_kind). Immutable after
 * site insert. Sites are uniformly 'website' kind in the post-rename model;
 * 'email' is reserved for newsletters/events/calendars hosting libraries.
 *
 * Renamed from 'html' / 'nextjs' in templates_013 + sites_010.
 */
export type ThemeKind = 'email' | 'website';

export interface PublishingTarget {
  kind: 'portal' | 'k8s-internal' | 'external';
  /** Required when kind === 'external' — the publisher sub-module's id (e.g. 'sites-publisher-vercel'). */
  publisherId?: string;
  /** Reference into sites_secrets.key — the publisher's auth/config bundle. NEVER a literal token. */
  configRef?: string;
  /** Used by k8s-internal: name of the IngressClass. */
  ingressClass?: string;
}

export interface SiteSeoConfig {
  defaultTitle?: string;
  defaultDescription?: string;
  ogImageUrl?: string;
  robots?: 'index' | 'noindex';
}

export interface SiteThemeConfig {
  cssUrl?: string;
  fontStackUrl?: string;
}

export interface SiteAnalyticsConfig {
  provider: 'plausible' | 'fathom' | 'umami' | 'ga4' | 'none';
  siteId?: string;
}

export interface SiteConfig {
  seo?: SiteSeoConfig;
  theme?: SiteThemeConfig;
  defaultWrapperKey?: string;
  sitemap?: { enabled: boolean; basePriority?: number };
  analytics?: SiteAnalyticsConfig;
  abEngineId?: string; // 'builtin' | 'optimizely' | 'growthbook' | …
  isolationLevel?: 'shared-cookie' | 'subdomain-cookie';
}

export type GitProvenance = 'internal' | 'external';

export interface SiteRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: SiteStatus;
  publishing_target: PublishingTarget;
  custom_domain_id: string | null;
  config: SiteConfig;
  templates_library_id: string | null;
  theme_kind: ThemeKind;
  /** Per spec §6: site-level wrapper FK. Defaults to library's role=site default. */
  wrapper_id: string | null;
  /** Per spec §6.4: where the underlying git repo lives. */
  git_provenance: GitProvenance;
  /** External: GitHub/GitLab clone URL. Internal: NULL or internal HTTPS endpoint. */
  git_url: string | null;
  /** Per-site Git LFS opt-in (v1.x for internal repos). */
  git_lfs_enabled: boolean;
  /** Per spec §12: site-level auth opt-in. */
  auth_enabled: boolean;
  /** Per spec §12.7: enabled Supabase Auth providers. */
  auth_providers: string[];
  /** Per spec §17: brand-wide cookie scope override; NULL = .brandname.com. */
  auth_session_cookie_domain: string | null;
  /** Per spec §13: per-site compliance audit toggle. */
  compliance_audit_enabled: boolean;
  /** Per spec §13.4: { cookie_banner_enabled, privacy_routes_enabled, audit_enabled } overrides. */
  compliance_overrides: Record<string, boolean>;
  /** Per spec §6.7: cron expression for scheduled republish. */
  publish_schedule_cron: string | null;
  /** Per spec §6.7: HMAC secret for /api/webhooks/republish/:siteSlug — never returned to admins via SiteRow reads. */
  republish_webhook_secret?: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface SiteSecretRow {
  id: string;
  site_id: string;
  key: string;
  /** encrypted_value is NEVER exposed to clients. */
  created_at: string;
  updated_at: string;
}

export interface SiteEditorPermissionRow {
  id: string;
  site_id: string;
  user_id: string;
  can_publish: boolean;
  granted_at: string;
  granted_by: string | null;
}

export interface SiteMediaRow {
  id: string;
  site_id: string;
  storage_provider: 'supabase' | 's3' | 'bunny';
  storage_path: string;
  public_url: string;
  filename: string;
  mime: string;
  size: number;
  alt_text: string | null;
  caption: string | null;
  width: number | null;
  height: number | null;
  uploaded_by: string | null;
  created_at: string;
}

// ----------------------------------------------------------------------------
// Pages (host-polymorphic)
// ----------------------------------------------------------------------------

export type HostKind = 'site' | 'portal' | 'event' | 'calendar' | 'blog_post' | (string & { readonly __brand?: 'host_kind' });
export type PageStatus = 'draft' | 'scheduled' | 'published' | 'archived';

export interface PageSeoOverride {
  title?: string;
  description?: string;
  ogImageUrl?: string;
  canonicalUrl?: string;
  robots?: 'index' | 'noindex';
  structuredData?: Record<string, unknown>;
}

/**
 * Per spec-content-modules-git-architecture §8.3: page composition mode.
 * Immutable after page-create. schema = pages.content JSONB; blocks =
 * page_blocks + page_block_bricks (with trg_page_blocks_match_composition_mode).
 */
export type CompositionMode = 'schema' | 'blocks';

export interface PageRow {
  id: string;
  host_kind: HostKind;
  host_id: string | null;
  templates_library_id: string;
  parent_page_id: string | null;
  slug: string;
  full_path: string;
  title: string;
  template_def_id: string | null;
  wrapper_def_id: string | null;
  /** Per spec §10.2: optional page-level wrapper FK. */
  wrapper_id: string | null;
  /** Per spec §8.3: immutable post-create. */
  composition_mode: CompositionMode;
  /** Per spec §10.6: explicit ordering for sub-nav consumed by useSectionPages. */
  section_order: number;
  status: PageStatus;
  publish_at: string | null;
  unpublish_at: string | null;
  seo: PageSeoOverride;
  ab_test_id: string | null;
  is_homepage: boolean;
  /** Editor-side optimistic-concurrency counter; bumped by trigger on any content write. */
  version: number;
  /**
   * Website path only: the conformant content document. Required for pages
   * on theme_kind='website' sites (enforced by
   * trg_pages_content_matches_kind). Other host kinds (newsletters, events,
   * calendars) compose content via page_blocks instead.
   */
  content: Record<string, unknown> | null;
  /** Templates module's content_schema_version that this page's content conforms to. */
  content_schema_version: number | null;
  /**
   * Monotonic publish counter. Incremented on each successful publish_job
   * finalize. Distinct from `version` (which tracks editor edits). Used by
   * pages_content_versions for rollback.
   */
  published_version: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export type AbSplit =
  | { kind: 'percent'; weights: Record<string, number> }
  | { kind: 'manual'; forceVariant: string };

export interface PageBlockVisibility {
  audience?: 'logged_in' | 'anon' | 'both';
  schedule?: { from?: string | null; until?: string | null };
  featureFlag?: string;
}

export interface PageBlockRow {
  id: string;
  page_id: string;
  block_def_id: string;
  sort_order: number;
  variant_key: string;
  ab_split: AbSplit | null;
  content: Record<string, unknown>;
  visibility: PageBlockVisibility;
  created_at: string;
  updated_at: string;
}

export interface PageBlockBrickRow {
  id: string;
  page_block_id: string;
  brick_def_id: string;
  sort_order: number;
  content: Record<string, unknown>;
  variant_key: string;
  created_at: string;
  updated_at: string;
}

export interface MediaRefRow {
  id: string;
  media_id: string;
  source_kind: 'page_block' | 'page_block_brick' | 'site_seo' | 'page_seo';
  source_id: string;
  created_at: string;
}

// ----------------------------------------------------------------------------
// Next.js theme kind tables — per spec-sites-theme-kinds §8.1
// ----------------------------------------------------------------------------

export interface PageNextjsDraftRow {
  id: string;
  page_id: string;
  /** Platform user id (the editor whose draft this is). */
  editor_id: string;
  /** Conforms to the schema declared by `schema_version`. */
  content: Record<string, unknown>;
  /** Captured when the draft was loaded; nullable for first-ever draft. */
  base_commit_sha: string | null;
  /** templates_content_schemas.version this draft was authored against. */
  schema_version: number;
  updated_at: string;
  created_at: string;
}

/**
 * Per-(page_id, field_path) personalization variant. Resolution rule defined
 * in spec-sites-theme-kinds §7.6: highest specificity wins; ties broken by
 * updated_at DESC then id ASC.
 */
export interface PageContentVariantRow {
  id: string;
  page_id: string;
  /** JSON Pointer to the variant's field within the schema. */
  field_path: string;
  /**
   * The flat-form RenderContext subset that triggers this variant. Per spec
   * §7.6.0, MUST be the canonical flat dot-notation form (rejected at API
   * boundary if nested).
   */
  match_context: Record<string, string | number | boolean | null>;
  /** SHA-256 hex of canonical_jsonb(match_context). Generated column. */
  match_context_hash: string;
  /** Replacement value at field_path. Same JSON shape as the base content's value at that path. */
  content: unknown;
  variant_label: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface PageContentVersionRow {
  id: string;
  page_id: string;
  /** Mirrors pages.published_version at write time. */
  version: number;
  /** Snapshot of pages.content at this published version. */
  content: Record<string, unknown>;
  source_commit_sha: string | null;
  source_publish_job_id: string | null;
  published_at: string;
}

export type PublishJobStatus =
  | 'queued' | 'preparing' | 'committing' | 'awaiting_build' | 'build_started'
  | 'finalizing' | 'succeeded' | 'build_failed' | 'cancelled' | 'conflict' | 'failed'
  | 'finalization_failed';

export type BranchStrategy = 'direct' | 'pull_request' | 'content_branch';

/**
 * Status detail per publish-job stage. Mirrors the §7.7.1-style detail union
 * but for the git-driven path (stage names match §6.4 state machine).
 */
export type PublishJobStatusDetail =
  | { stage: 'queued' }
  | { stage: 'preparing' }
  | { stage: 'committing'; files_count: number }
  | { stage: 'awaiting_build' }
  | { stage: 'build_started'; deployment_id: string }
  | { stage: 'finalizing' }
  | { stage: 'succeeded'; commit_sha: string; deployment_url: string | null }
  | { stage: 'build_failed'; commit_sha: string; reason: string; log_url?: string }
  | { stage: 'cancelled'; cancelled_in: 'queued' | 'preparing' | 'committing' | 'awaiting_build' | 'build_started' | 'finalizing'; cancelled_by: string }
  | { stage: 'conflict'; expected_base: string; actual_base: string }
  | { stage: 'failed'; failed_in: 'preparing' | 'committing' | 'awaiting_build' | 'finalizing'; error_summary: string }
  | { stage: 'finalization_failed'; attempt_count: number; last_error: string };

export interface SitesPublishJobRow {
  id: string;
  page_id: string;
  site_id: string;
  publisher_id: string;
  base_commit_sha: string | null;
  branch: string | null;
  branch_strategy: BranchStrategy;
  /** Captured at queue time. Copied to pages.content on finalize. */
  draft_content_snapshot: Record<string, unknown>;
  draft_schema_version: number;
  status: PublishJobStatus;
  status_detail: PublishJobStatusDetail | null;
  files: Array<{ path: string; content_hash: string }>;
  result_commit_sha: string | null;
  result_pr_url: string | null;
  result_pr_number: number | null;
  result_deployment_id: string | null;
  result_deployment_url: string | null;
  error: string | null;
  log_object_key: string | null;
  log_truncated_tail: string | null;
  started_at: string | null;
  finished_at: string | null;
  debounce_until: string | null;
  heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface SitesWebhookSeenRow {
  publisher_id: string;
  deployment_id: string;
  event_kind: string;
  seen_at: string;
}

export interface SitesRuntimeApiKeyRow {
  id: string;
  site_id: string;
  slot: 'primary' | 'secondary';
  /** Cleartext prefix for admin display (e.g. "gw_runtime_aaif_a1b2c3..."). NOT secret. */
  key_prefix: string;
  /** HMAC-SHA256(full_key, platform_pepper). Cleartext key never stored. */
  key_hash: string;
  rate_limit_rps: number;
  created_by: string | null;
  created_at: string;
  rotated_at: string | null;
  revoked_at: string | null;
}

// ----------------------------------------------------------------------------
// RenderContext (runtime content API) — per spec §7.1 / §7.6.0
// ----------------------------------------------------------------------------

/**
 * Canonical flat dot-notation form. The runtime API rejects nested forms at
 * the boundary and normalizes ergonomic-but-nested submissions before
 * variant matching.
 */
export type RenderContextFlat = Record<string, string | number | boolean | null>;

/** Ergonomic nested form accepted by the API but flattened immediately on receipt. */
export interface RenderContextNested {
  persona?: string;
  utm?: { source?: string; medium?: string; campaign?: string; term?: string; content?: string };
  geo?: { country?: string; region?: string; city?: string; lat?: number; lon?: number };
  locale?: string;
  viewer?: { authenticated: boolean; userId?: string; roles?: string[] };
}

export interface PagePreviewTokenRow {
  id: string;
  page_id: string;
  /** SHA-256 of the raw token. The raw token is returned exactly once on creation and never persisted. */
  token_hash: string;
  expires_at: string;
  created_at: string;
  created_by: string | null;
  revoked_at: string | null;
}

export interface PageHostRegistrationRow {
  host_kind: HostKind;
  module_id: string;
  url_prefix_template: string;
  can_admin_fn: string;
  can_edit_pages_fn: string;
  can_publish_fn: string;
  default_wrapper_key: string | null;
  enabled: boolean;
  /**
   * Which theme_kinds this consumer accepts. Newsletters/events/calendars
   * register with ['email']. Sites register with ['website']. The host
   * picks one — there's no longer a host that accepts both kinds.
   */
  accepted_theme_kinds: ThemeKind[];
  registered_at: string;
}

// ----------------------------------------------------------------------------
// Publisher deployments + external domains
// ----------------------------------------------------------------------------

export type DeploymentStatus =
  | 'queued' | 'preparing' | 'rendering' | 'syncing_media' | 'deploying'
  | 'cancelling' | 'succeeded' | 'cancelled' | 'failed';

export type DeploymentStatusDetail =
  | { stage: 'queued' }
  | { stage: 'preparing' }
  | { stage: 'rendering'; completed: number; total: number }
  | { stage: 'syncing_media'; completed: number; total: number }
  | { stage: 'preparing_artifact' }
  | { stage: 'deploying' }
  | { stage: 'cancelling' }
  | { stage: 'succeeded' }
  | { stage: 'failed'; failed_in: 'preparing' | 'rendering' | 'syncing_media' | 'preparing_artifact' | 'deploying'; error_summary: string }
  | { stage: 'cancelled'; cancelled_in: 'preparing' | 'rendering' | 'syncing_media' | 'preparing_artifact' | 'deploying'; cancelled_by: string };

export interface PublisherDeploymentRow {
  id: string;
  site_id: string;
  publisher_id: string;
  status: DeploymentStatus;
  status_detail: DeploymentStatusDetail | null;
  artifact_manifest: Record<string, unknown> | null;
  public_url: string | null;
  publisher_deploy_id: string | null;
  cdn_domains: string[];
  duration_ms: number | null;
  log_object_key: string | null;
  log_truncated_tail: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  debounce_until: string | null;
  heartbeat_at: string | null;
  created_at: string;
  triggered_by: string | null;
}

export type ExternalDomainState = 'pending_dns' | 'pending_verification' | 'verified' | 'misconfigured';

export interface ExternalDomainDnsInstruction {
  record_type: 'A' | 'AAAA' | 'CNAME' | 'TXT';
  host: string;
  value: string;
  ttl?: number;
}

export interface SitesExternalDomainRow {
  id: string;
  site_id: string;
  publisher_id: string;
  domain: string;
  state: ExternalDomainState;
  state_detail: string | null;
  dns_instructions: ExternalDomainDnsInstruction[];
  verification_handle: string | null;
  last_checked_at: string | null;
  added_at: string;
  added_by: string | null;
  verified_at: string | null;
}

// ----------------------------------------------------------------------------
// Publisher contract (for sub-modules: sites-publisher-vercel, etc.)
// ----------------------------------------------------------------------------

export interface BuildArtifact {
  buildId: string;
  artifactDir: string;                       // absolute path; container-local
  fileManifest: ReadonlyArray<{ relPath: string; sha256: string; size: number }>;
  dynamicEntrypoints: ReadonlyArray<{ relPath: string; runtime: 'node' | 'edge' | 'cloudflare-worker' }>;
  pageRoutes: ReadonlyArray<{ fullPath: string; relPath: string; cacheTtlSeconds: number }>;
}

export interface MediaRef {
  storagePath: string;
  publishedPath: string;
  size: number;
  mime: string;
}

export interface MediaSyncResult {
  mode: 'inline-in-artifact' | 'platform-managed';
  urlMap?: Record<string, string>;
  bytesSynced: number;
}

export interface DeploymentResult {
  publicUrl: string;
  deployId: string;
  cdnDomains: ReadonlyArray<string>;
  durationMs: number;
}

export interface PreviewResult {
  previewUrl: string;
  expiresAt?: string;
  deployId: string;
}

export interface DomainAddedResult {
  dnsInstructions: ReadonlyArray<ExternalDomainDnsInstruction>;
  verification_handle?: string;
}

export interface DomainStatusResult {
  state: ExternalDomainState;
  details?: string;
  attempted_at: string;
}

export interface DeploymentStatusResult {
  state: 'live' | 'building' | 'failed' | 'unknown';
  public_url?: string;
  error?: string;
}

export type PublisherSecrets = Record<string, string | number | boolean>;

export interface ValidationResult {
  ok: boolean;
  errors: ReadonlyArray<{ path: string; message: string }>;
}

export interface IExternalPublisher {
  validateConfig(secrets: PublisherSecrets): ValidationResult;
  prepareArtifact(
    artifact: BuildArtifact,
    secrets: PublisherSecrets,
  ): Promise<{ writtenFiles: ReadonlyArray<{ relPath: string; bytes: number }> }>;
  deploy(artifact: BuildArtifact, secrets: PublisherSecrets): Promise<DeploymentResult>;
  deployPreview(artifact: BuildArtifact, page: { id: string; fullPath: string }, secrets: PublisherSecrets): Promise<PreviewResult>;
  invalidateCache(secrets: PublisherSecrets, paths: string[]): Promise<void>;
  syncMedia(siteId: string, mediaRefs: ReadonlyArray<MediaRef>, secrets: PublisherSecrets): Promise<MediaSyncResult>;
  cleanupExpiredPreviews(secrets: PublisherSecrets, olderThanHours: number): Promise<number>;
  addDomain(domain: string, secrets: PublisherSecrets): Promise<DomainAddedResult>;
  getDomainStatus(domain: string, secrets: PublisherSecrets): Promise<DomainStatusResult>;
  removeDomain(domain: string, secrets: PublisherSecrets): Promise<void>;
  getDeploymentStatus(deployId: string, secrets: PublisherSecrets): Promise<DeploymentStatusResult>;
}

// ----------------------------------------------------------------------------
// Render context (handed to the templates module's render helpers)
// ----------------------------------------------------------------------------

export interface RenderTarget {
  kind: 'portal' | 'k8s-internal' | 'external';
  /** When kind === 'external' — the CDN base URL the renderer rewrites media URLs to. */
  cdnBaseUrl?: string;
  /** When kind === 'external' — the artifact path layout the renderer emits internal anchor URLs against. */
  artifactPathPrefix?: string;
}

// ============================================================================
// New tables introduced by spec-content-modules-git-architecture
// ============================================================================

/** sites/014_internal_repos.sql */
export interface InternalRepoRow {
  id: string;
  host_kind: 'site' | 'list';
  host_id: string;
  bare_path: string;
  default_branch: string;
  size_bytes: number;
  max_size_bytes: number;
  last_pushed_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

/** sites/015_host_media.sql */
export interface HostMediaRow {
  id: string;
  host_kind: 'site' | 'list' | 'newsletter';
  host_id: string;
  storage_path: string;
  filename: string;
  mime_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  variants: Record<string, string> | null;
  in_repo: boolean;
  used_in: Array<{ type: string; id: string; name: string }>;
  uploaded_by: string | null;
  created_at: string;
}

/** sites/016_navigation_menus.sql */
export interface NavigationMenuRow {
  id: string;
  host_kind: 'site';
  host_id: string;
  slug: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface NavigationMenuItemRow {
  id: string;
  menu_id: string;
  parent_id: string | null;
  order_index: number;
  label: string;
  page_id: string | null;
  external_url: string | null;
  anchor_target: string | null;
  open_in_new_tab: boolean;
  rel_attributes: string[] | null;
  css_classes: string | null;
  visibility: 'always' | 'authenticated_only' | 'public_only';
}

/** sites/019_republish_log.sql */
export interface SiteRepublishLogRow {
  id: string;
  site_id: string;
  trigger_kind: 'manual' | 'scheduled' | 'webhook' | 'mcp';
  triggered_by: string | null;
  webhook_request_id: string | null;
  reason: string | null;
  publish_commit_sha: string | null;
  publish_tag: string | null;
  status: 'pending' | 'success' | 'failed' | 'skipped_no_diff';
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

/** sites/020_boilerplate_versions.sql */
export interface BoilerplateVersionRow {
  boilerplate_id: string;
  latest_tag: string;
  release_notes_md: string | null;
  fetched_at: string;
}
