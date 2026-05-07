/**
 * @gatewaze-modules/sites/client-types
 *
 * Public TypeScript types for HTTP clients of the sites module.
 *
 * Two consumers in mind:
 *   1. Brand-side automation (CI scripts, support tools, integration code)
 *      that talks to the sites admin endpoints with a service-role JWT.
 *   2. Operator themes that hit the public A/B engine endpoints from the
 *      browser to record impressions / conversions.
 *
 * Internal types — `SiteRow`, `PageRow`, the full `PublishJobRow`, etc. —
 * live in `../types/index.ts` and may include columns that aren't returned
 * by HTTP responses (RLS-gated, encrypted, or admin-only). This file
 * narrows them to the over-the-wire shapes operators actually receive.
 *
 * Usage:
 *
 *   import type {
 *     CreatePageRequest,
 *     CreatePageResponse,
 *     ApiErrorEnvelope,
 *   } from '@gatewaze-modules/sites/client-types';
 *
 *   const res = await fetch('/api/modules/sites/admin/pages', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ host_kind: 'site', ... } satisfies CreatePageRequest),
 *   });
 *   const body = await res.json() as CreatePageResponse | ApiErrorEnvelope;
 */

// ----------------------------------------------------------------------------
// Common
// ----------------------------------------------------------------------------

/** Standard error envelope returned by every admin endpoint on non-2xx. */
export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** ISO-8601 timestamp string. */
export type IsoDate = string;

/** UUID string. Validated server-side; clients should treat as opaque. */
export type Uuid = string;

/** A site's URL path component, e.g. `/`, `/about`, `/blog/post-1`. */
export type RoutePath = string;

// ----------------------------------------------------------------------------
// Site / page rows (public-facing subsets)
// ----------------------------------------------------------------------------

export type SiteStatus = 'active' | 'archived';
export type ThemeKind = 'email' | 'website';
export type CompositionMode = 'schema' | 'blocks';
export type PageStatus = 'draft' | 'scheduled' | 'published' | 'archived';

export type GitProvenance = 'internal' | 'external';

export interface PublishingTarget {
  kind: 'portal' | 'k8s-internal' | 'external';
  /** Required when kind === 'external'. Identifies the publisher sub-module. */
  publisherId?: string;
  /** Reference into sites_secrets.key — never a literal token. */
  configRef?: string;
  /** Used by k8s-internal: name of the IngressClass. */
  ingressClass?: string;
}

export interface SiteAnalyticsConfig {
  provider: 'plausible' | 'fathom' | 'umami' | 'ga4' | 'none';
  siteId?: string;
  umami?: {
    umamiWebsiteId: string;
    umamiShareId?: string | null;
  };
}

export interface SiteConfig {
  seo?: {
    defaultTitle?: string;
    defaultDescription?: string;
    ogImageUrl?: string;
    robots?: 'index' | 'noindex';
  };
  theme?: {
    cssUrl?: string;
    fontStackUrl?: string;
  };
  defaultWrapperKey?: string;
  sitemap?: { enabled: boolean; basePriority?: number };
  analytics?: SiteAnalyticsConfig;
  abEngineId?: string;
  isolationLevel?: 'shared-cookie' | 'subdomain-cookie';
}

/** Site row as returned by admin endpoints — encrypted secrets stripped. */
export interface SiteSummary {
  id: Uuid;
  slug: string;
  name: string;
  description: string | null;
  status: SiteStatus;
  publishing_target: PublishingTarget;
  custom_domain_id: Uuid | null;
  config: SiteConfig;
  templates_library_id: Uuid | null;
  theme_kind: ThemeKind;
  git_provenance?: GitProvenance;
  git_url?: string | null;
  created_at: IsoDate;
  updated_at: IsoDate;
}

export interface PageSummary {
  id: Uuid;
  host_kind: string;
  host_id: Uuid | null;
  parent_page_id: Uuid | null;
  slug: string;
  full_path: RoutePath;
  title: string;
  template_def_id: Uuid | null;
  wrapper_def_id: Uuid | null;
  composition_mode: CompositionMode;
  status: PageStatus;
  is_homepage: boolean;
  publish_at: IsoDate | null;
  unpublish_at: IsoDate | null;
  version: number;
  published_version: number;
  content_schema_version: number | null;
  seo: Record<string, unknown>;
  created_at: IsoDate;
  updated_at: IsoDate;
}

// ----------------------------------------------------------------------------
// Pages — admin endpoints
// ----------------------------------------------------------------------------

/** POST /api/modules/sites/admin/pages */
export interface CreatePageRequest {
  host_kind: string;
  host_id: Uuid | null;
  templates_library_id: Uuid;
  parent_page_id?: Uuid | null;
  slug: string;
  full_path?: RoutePath;
  title: string;
  template_def_id?: Uuid | null;
  wrapper_def_id?: Uuid | null;
  composition_mode?: CompositionMode;
  status?: PageStatus;
  publish_at?: IsoDate | null;
  unpublish_at?: IsoDate | null;
  seo?: Record<string, unknown>;
  is_homepage?: boolean;
}
export type CreatePageResponse = PageSummary;

/** PATCH /api/modules/sites/admin/pages/:pageId — partial update. */
export interface UpdatePageRequest {
  parent_page_id?: Uuid | null;
  slug?: string;
  full_path?: RoutePath;
  title?: string;
  template_def_id?: Uuid | null;
  wrapper_def_id?: Uuid | null;
  status?: PageStatus;
  publish_at?: IsoDate | null;
  unpublish_at?: IsoDate | null;
  seo?: Record<string, unknown>;
  is_homepage?: boolean;
}
export type UpdatePageResponse = PageSummary;

/** GET /api/modules/sites/admin/pages?host_kind=…&host_id=… */
export interface ListPagesQuery {
  host_kind: string;
  host_id?: Uuid;
}
export interface ListPagesResponse {
  pages: PageSummary[];
}

// ----------------------------------------------------------------------------
// Preview tokens
// ----------------------------------------------------------------------------

export interface CreatePreviewTokenResponse {
  id: Uuid;
  /** Cleartext token — returned exactly once; clients persist it. */
  token: string;
  expires_at: IsoDate;
}

// ----------------------------------------------------------------------------
// Schema-mode draft batch save
// ----------------------------------------------------------------------------

export interface DraftSaveItem {
  route: RoutePath;
  content: Record<string, unknown>;
  schemaVersion: number;
  baseCommitSha?: string | null;
}

/** POST /api/modules/sites/admin/sites/:siteSlug/content:batch */
export interface BatchSaveContentRequest {
  drafts: DraftSaveItem[];
}
export interface BatchSaveContentResponse {
  drafts: Array<{
    route: RoutePath;
    page_id: Uuid;
    draft_id: Uuid;
    version: number;
  }>;
}

// ----------------------------------------------------------------------------
// Site lifecycle endpoints
// ----------------------------------------------------------------------------

/** POST /api/modules/sites/admin/sites/:siteId/internal-repo:ensure */
export interface EnsureInternalRepoResponse {
  /** Filesystem path of the bare repo (server-side path; not browser-reachable). */
  barePath?: string;
  defaultBranch?: string;
  /** Set when the platform doesn't run a publish-worker (no-op success). */
  created?: false;
  reason?: 'git_server_unavailable';
}

/** POST /api/modules/sites/admin/sites/:siteId/integrations:provision */
export interface ProvisionIntegrationsResponse {
  /** Tags like 'umami:created', 'umami:existing'. */
  provisioned: string[];
  failed: Array<{ integration: string; reason: string }>;
  /** Updated analytics block now persisted on sites.config.analytics. */
  analytics: SiteAnalyticsConfig | Record<string, unknown>;
}

/** POST /api/modules/sites/admin/sites/:siteId/archive */
export interface ArchiveSiteResponse {
  archived: true;
  cleanupErrors: Array<{ step: string; reason: string }>;
}

// ----------------------------------------------------------------------------
// Connect-git import / refresh
// ----------------------------------------------------------------------------

/** POST /api/modules/sites/admin/sites/:siteId/source:import-git */
export interface ImportGitRequest {
  git_url: string;
  pat: string;
  branch?: string;
  /** Defaults to 'content/schema.json'. Supports .json / .ts / .tsx. */
  schema_path?: string;
}
export interface ImportGitResponse {
  sourceId: Uuid;
  libraryId: Uuid;
  schemaId: Uuid;
  schemaVersion: number;
  mainSha: string;
  branch: string;
}

/** POST /api/modules/sites/admin/sites/:siteId/source/:sourceId/refresh-git */
export interface RefreshGitRequest {
  schema_path?: string;
}
export type RefreshGitResponse = ImportGitResponse;

// ----------------------------------------------------------------------------
// Publishing
// ----------------------------------------------------------------------------

export type PublishJobStatus =
  | 'queued'
  | 'preparing'
  | 'committing'
  | 'awaiting_build'
  | 'build_started'
  | 'finalizing'
  | 'succeeded'
  | 'build_failed'
  | 'cancelled'
  | 'conflict'
  | 'failed'
  | 'finalization_failed';

export interface PublishJobSummary {
  id: Uuid;
  page_id: Uuid | null;
  publisher_id: string;
  status: PublishJobStatus;
  result_pr_url: string | null;
  result_deployment_url: string | null;
  started_at: IsoDate | null;
  finished_at: IsoDate | null;
  error: string | null;
  created_at: IsoDate;
}

/** POST /api/admin/sites/:siteId/publish */
export interface PublishSiteRequest {
  reason?: string;
  force?: boolean;
}
export interface PublishSiteResponse {
  publishId: Uuid;
  status: 'pending' | 'queued';
}

/** POST /api/modules/sites/admin/sites/:siteId/publish-jobs/:jobId/rollback */
export interface RollbackPublishJobResponse {
  /** ID of the new queued job that re-applies the prior snapshot. */
  id: Uuid;
  status: 'queued';
  /** ID of the prior succeeded job whose snapshot was cloned. */
  rolled_back_from: Uuid;
}

// ----------------------------------------------------------------------------
// Publisher secrets + validate
// ----------------------------------------------------------------------------

/** PUT /api/modules/sites/admin/sites/:siteId/secrets */
export interface PutSiteSecretRequest {
  /** Secret bundle key. Matches `^[a-z][a-z0-9_]{0,62}$`. */
  key: string;
  values: Record<string, string | number | boolean | null>;
}
export interface PutSiteSecretResponse {
  id: Uuid;
  key: string;
  action: 'created' | 'updated';
}

/** POST /api/modules/sites/admin/sites/:siteId/publisher:validate */
export interface ValidatePublisherRequest {
  publisherId: string;
  /** Optional override values; when absent, validates the stored bundle. */
  values?: Record<string, unknown>;
}
export interface ValidatePublisherResponse {
  ok: boolean;
  errors: ReadonlyArray<{ path: string; message: string }>;
  ping: {
    ok: boolean;
    status: number | null;
    message: string;
  } | null;
}

// ----------------------------------------------------------------------------
// A/B engine — public endpoints (no auth, rate-limited per session key)
// ----------------------------------------------------------------------------

export type AbScopeKind = 'page' | 'block_instance' | 'edition' | 'layout';
export type AbTestStatus = 'draft' | 'running' | 'paused' | 'concluded';

export interface AbVariant {
  key: string;
  /** 0..100; sum across variants must equal 100. */
  weight: number;
}

export interface AbTestSummary {
  id: Uuid;
  scope_kind: AbScopeKind;
  scope_id: Uuid;
  host_kind: string;
  host_id: Uuid | null;
  name: string;
  variants: AbVariant[];
  goal_event: string;
  status: AbTestStatus;
  engine_id: string;
  started_at: IsoDate | null;
  ended_at: IsoDate | null;
  winner_variant: string | null;
  created_at: IsoDate;
}

/** POST /api/ab/:testId/assign */
export interface AbAssignRequest {
  /** UUID-like, 8–128 chars from `[A-Za-z0-9_-]`. Persisted in localStorage. */
  sessionKey: string;
}
export interface AbAssignResponse {
  variant: string;
  /** True when the assignment row already existed (stickiness). */
  sticky: boolean;
  /** Set when the test is paused and no prior assignment exists. */
  paused?: boolean;
}

/** POST /api/ab/:testId/impression — 204 on success, no body. */
export interface AbImpressionRequest {
  sessionKey: string;
  variant: string;
  /** Free-form event metadata. Stored on templates_ab_events.properties. */
  properties?: Record<string, unknown>;
}

/** POST /api/ab/:testId/conversion — 204 on success, no body. */
export interface AbConversionRequest {
  sessionKey: string;
  variant: string;
  /** Must match the test's configured `goal_event` or the request 400s. */
  goalEvent: string;
  properties?: Record<string, unknown>;
}

// ----------------------------------------------------------------------------
// A/B engine — admin endpoints (RLS-gated)
// ----------------------------------------------------------------------------

export interface CreateAbTestRequest {
  scope_kind: AbScopeKind;
  scope_id: Uuid;
  host_kind: string;
  host_id: Uuid | null;
  name: string;
  variants: AbVariant[];
  goal_event: string;
}
export type CreateAbTestResponse = AbTestSummary;

export interface SetAbTestStatusRequest {
  status: AbTestStatus;
  /** Required when status='concluded' if you want to record a winner. */
  winner_variant?: string;
}

// ----------------------------------------------------------------------------
// Per-variant content
// ----------------------------------------------------------------------------

/** Content for a single variant of a single page. Stored in pages_content_variants. */
export interface AbVariantContent {
  variant: string;
  content: Record<string, unknown>;
}

export interface UpsertVariantContentRequest {
  pageId: Uuid;
  testId: Uuid;
  variant: string;
  content: Record<string, unknown>;
  variantLabel?: string;
}

// ----------------------------------------------------------------------------
// Site-runtime config (browser-readable)
// ----------------------------------------------------------------------------

/**
 * Shape of `public/_gatewaze/site-config.json` — emitted by the publish-
 * worker into every site's static-asset tree. Consumed by
 * `<GatewazeHead />` and any first-paint inline integrations.
 */
export interface SiteRuntimeConfig {
  /** Origin where the rendered site posts A/B events. Null when unconfigured. */
  apiOrigin: string | null;
  analytics: {
    provider: SiteAnalyticsConfig['provider'];
    umami?: { url: string; websiteId: string };
  };
  /** Public URL of the per-route A/B bindings file. */
  abBindingsUrl: string;
}

/** Shape of `public/_gatewaze/ab-bindings.json` — one entry per route with a running test. */
export type AbBindingsByRoute = Record<RoutePath, { testId: Uuid; goalEvent: string }>;

// ----------------------------------------------------------------------------
// Per-page content files emitted by the publish-worker
// ----------------------------------------------------------------------------

export interface SchemaModePageContent {
  slug: string;
  full_path: RoutePath;
  title: string;
  content: Record<string, unknown>;
  schema_version: number | null;
}

export interface BlocksModePageContent {
  slug: string;
  full_path: RoutePath;
  title: string;
  composition_mode: 'blocks';
  blocks: Array<{
    block_def_name: string | null;
    sort_order: number;
    variant_key: string;
    content: Record<string, unknown>;
    bricks?: Array<{
      brick_def_name: string | null;
      sort_order: number;
      variant_key: string;
      content: Record<string, unknown>;
    }>;
  }>;
}

export type PageContentFile = SchemaModePageContent | BlocksModePageContent;

/** Per-variant content file at content/pages/<slug>.<variant>.json. */
export interface VariantContentFile {
  slug: string;
  full_path: RoutePath;
  variant: string;
  content: Record<string, unknown>;
}

// ----------------------------------------------------------------------------
// Browser globals exposed by the A/B bootstrap
// ----------------------------------------------------------------------------

/**
 * Shape of `window.gatewazeAB` once the bootstrap has resolved an assignment.
 * Operator theme code reads this after the `gatewaze:ab-ready` event fires.
 *
 * Add to your theme's global types via:
 *
 *   declare global {
 *     interface Window { gatewazeAB?: GatewazeAbWindow; }
 *   }
 */
export interface GatewazeAbWindow {
  variant: string;
  testId: Uuid;
  goalEvent: string;
  /** Per-variant content from pages_content_variants. Null when no override. */
  variantContent: Record<string, unknown> | null;
  /** Records a conversion. Defaults to the test's configured goalEvent. */
  recordConversion(goalEvent?: string): Promise<void>;
}

/**
 * Shape of the `gatewaze:ab-ready` CustomEvent.detail. Use this to subscribe:
 *
 *   window.addEventListener('gatewaze:ab-ready', (e) => {
 *     const detail = (e as CustomEvent<GatewazeAbReadyDetail>).detail;
 *     ...
 *   });
 */
export type GatewazeAbReadyDetail = GatewazeAbWindow;
