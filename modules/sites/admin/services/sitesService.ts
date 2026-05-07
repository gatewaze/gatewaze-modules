/**
 * Sites admin service — DB CRUD for sites + their child collections.
 *
 * Mirrors the calendars / events admin-service pattern: thin wrapper around
 * Supabase that returns either the data or a typed error string. UI calls
 * these from `useEffect` and renders empty / error states.
 */

import { supabase } from '@/lib/supabase';
import type {
  SiteRow,
  PageRow,
  PublishingTarget,
  ThemeKind,
  SiteConfig,
  SitesPublishJobRow,
} from '../../types';
import {
  isSitesThemeKindsEnabled,
  THEME_KINDS_DISABLED_ERROR,
} from '../../lib/feature-flags/index.js';

// ---------------------------------------------------------------------------
// Starter content schema (provisioned for new website-kind sites).
// Operators replace this when they connect a real git source via Source tab.
// ---------------------------------------------------------------------------

const STARTER_CONTENT_SCHEMA_JSON = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Starter page',
  type: 'object',
  properties: {
    heroTitle: { type: 'string', title: 'Hero heading' },
    heroBody: { type: 'string', format: 'html', title: 'Hero body' },
    sections: {
      type: 'array',
      title: 'Sections',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', title: 'Section title' },
          body: { type: 'string', format: 'html', title: 'Section body' },
        },
        required: ['title'],
      },
    },
  },
} as const;

// Web Crypto sha256 → 64-char lowercase hex. Required by the
// templates_content_schemas.schema_hash CHECK (`^[0-9a-f]{64}$`).
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export interface SiteSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: 'active' | 'archived';
  theme_kind: ThemeKind;
  publishing_target: PublishingTarget;
  custom_domain_id: string | null;
  pageCount?: number;
  created_at: string;
  updated_at: string;
}

export const SitesService = {
  async listSites(): Promise<{ sites: SiteSummary[]; error: string | null }> {
    const { data, error } = await supabase
      .from('sites')
      .select('id, slug, name, description, status, theme_kind, publishing_target, custom_domain_id, created_at, updated_at')
      .order('created_at', { ascending: false });

    if (error) return { sites: [], error: error.message };
    return { sites: (data ?? []) as SiteSummary[], error: null };
  },

  async getSite(slug: string): Promise<{ site: SiteRow | null; error: string | null }> {
    const { data, error } = await supabase
      .from('sites')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();
    if (error) return { site: null, error: error.message };
    return { site: data as SiteRow | null, error: null };
  },

  async createSite(args: {
    slug: string;
    name: string;
    description?: string;
    theme_kind: ThemeKind;
    config?: SiteConfig;
  }): Promise<{ site: SiteRow | null; error: string | null }> {
    // Per spec-sites-theme-kinds §16.1: refuse Next.js sites unless the
    // platform_settings.sites_theme_kinds_enabled flag is on. Operators
    // flip it after verifying migrations + publisher infra in each env.
    if (args.theme_kind === 'nextjs') {
      const enabled = await isSitesThemeKindsEnabled(supabase);
      if (!enabled) return { site: null, error: THEME_KINDS_DISABLED_ERROR.message };
    }

    const { data, error } = await supabase
      .from('sites')
      .insert({
        slug: args.slug,
        name: args.name,
        description: args.description ?? null,
        theme_kind: args.theme_kind,
        status: 'active',
        publishing_target: { kind: 'portal' } satisfies PublishingTarget,
        config: args.config ?? {},
      })
      .select('*')
      .single();
    if (error) return { site: null, error: error.message };

    const apiUrl = (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
    const newSiteId = (data as SiteRow).id;

    // Auto-provision a starter library so the user can immediately
    // create pages. Server endpoint runs with service-role so the
    // sites.templates_library_id link-back doesn't get silently
    // blocked by RLS (the browser-side path used to leave the
    // FK NULL even when the library + wrapper + source rows succeeded).
    try {
      const libRes = await fetch(
        `${apiUrl}/api/modules/sites/admin/sites/${newSiteId}/library:provision-starter`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders } },
      );
      if (!libRes.ok) {
        const body = await libRes.json().catch(() => ({}));
        console.warn('[sites] library:provision-starter returned', libRes.status, body);
      }
    } catch (err) {
      console.warn('[sites] library:provision-starter call failed:', err);
    }

    // Fire-and-forget internal repo provisioning. Idempotent (returns the
    // existing repo if one is already registered). When the API server
    // doesn't run the publish-worker (e.g., a frontend-only deploy), the
    // endpoint succeeds silently with reason='git_server_unavailable'.
    try {
      const repoRes = await fetch(
        `${apiUrl}/api/modules/sites/admin/sites/${newSiteId}/internal-repo:ensure`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders } },
      );
      if (!repoRes.ok) {
        // eslint-disable-next-line no-console
        console.warn('[sites] internal-repo:ensure returned', repoRes.status);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[sites] internal-repo:ensure call failed:', err);
    }

    // Fire-and-forget integration provisioning (Umami etc.). The endpoint
    // is idempotent and best-effort: a failure here doesn't prevent the
    // site from being usable. The result lands on sites.config.analytics
    // and the publish-worker reads it at render time.
    try {
      const provRes = await fetch(
        `${apiUrl}/api/modules/sites/admin/sites/${newSiteId}/integrations:provision`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders } },
      );
      if (!provRes.ok) {
        // eslint-disable-next-line no-console
        console.warn('[sites] integrations:provision returned', provRes.status);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[sites] integrations:provision call failed:', err);
    }

    // Re-read so the caller sees the updated templates_library_id + analytics config.
    const refreshed = await supabase.from('sites').select('*').eq('id', (data as SiteRow).id).maybeSingle();
    return { site: (refreshed.data as SiteRow | null) ?? (data as SiteRow), error: null };
  },

  async updateSite(
    siteId: string,
    patch: Partial<Pick<SiteRow, 'name' | 'description' | 'config' | 'publishing_target' | 'custom_domain_id' | 'status'>>,
  ): Promise<{ site: SiteRow | null; error: string | null }> {
    const updates: Record<string, unknown> = { ...patch };
    const { data, error } = await supabase
      .from('sites')
      .update(updates)
      .eq('id', siteId)
      .select('*')
      .single();
    if (error) return { site: null, error: error.message };
    return { site: data as SiteRow, error: null };
  },

  /**
   * Archive a site via the server-side endpoint, which cascades cleanup:
   *   - Sets sites.status='archived'
   *   - Soft-deletes the internal git repo (30-day retention)
   *   - Deletes the corresponding Umami website if umami is wired
   *   - Concludes any in-flight A/B tests scoped to the site
   *
   * Falls back to a direct Supabase UPDATE if the server is unavailable so
   * the UI flow doesn't dead-end. Cleanup is then incomplete; the operator
   * can re-trigger via the same endpoint.
   */
  async archiveSite(siteId: string): Promise<{ error: string | null }> {
    const apiUrl = (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    try {
      const res = await fetch(`${apiUrl}/api/modules/sites/admin/sites/${siteId}/archive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (res.ok) return { error: null };
      // Non-OK from server: fall through to the direct UPDATE so the user
      // still gets the site marked archived.
      const body = await res.json().catch(() => ({}));
      // eslint-disable-next-line no-console
      console.warn('[sites] archive endpoint returned', res.status, body);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[sites] archive endpoint unreachable:', err);
    }
    const { error } = await supabase
      .from('sites')
      .update({ status: 'archived' })
      .eq('id', siteId);
    return { error: error?.message ?? null };
  },

  /**
   * Provision a starter templates_library for a website-kind site:
   *   1. INSERT templates_libraries (host_kind='site', theme_kind='website')
   *   2. INSERT templates_wrappers (default <html> shell)
   *   3. INSERT templates_sources (kind='inline', theme_kind='website')
   *   4. INSERT templates_content_schemas (a minimal home/about page schema)
   *   5. UPDATE sites.templates_library_id
   *
   * No-op if the site already has a library. Returns the library_id.
   *
   * Why no block_defs: website-kind sites use schema-driven content
   * (pages.content JSONB conforming to a templates_content_schemas row),
   * not the marker-grammar block_defs that email-kind libraries use. Those
   * still ship with newsletters via NewsletterSetupWizard.
   */
  async provisionStarterLibrary(args: {
    siteId: string;
    siteName: string;
    themeKind: ThemeKind;
  }): Promise<{ libraryId: string | null; error: string | null }> {
    const existing = await supabase
      .from('sites')
      .select('templates_library_id')
      .eq('id', args.siteId)
      .maybeSingle();
    if (existing.data?.templates_library_id) {
      return { libraryId: existing.data.templates_library_id as string, error: null };
    }

    // 1. library
    const libRes = await supabase
      .from('templates_libraries')
      .insert({
        host_kind: 'site',
        host_id: args.siteId,
        name: `${args.siteName} library`,
        description: `Auto-provisioned starter library for site ${args.siteName}.`,
        theme_kind: args.themeKind,
      })
      .select('id')
      .single();
    if (libRes.error || !libRes.data) {
      return { libraryId: null, error: libRes.error?.message ?? 'Library insert returned no row' };
    }
    const libraryId = libRes.data.id as string;

    // 2. wrapper — bare HTML shell. The marker {{>page_body}} is replaced
    // by the rendered route content; {{>head}} carries injected analytics
    // / SEO tags so the umami integration can plug in without re-templating.
    const wrapperRes = await supabase
      .from('templates_wrappers')
      .insert({
        library_id: libraryId,
        key: 'default',
        name: 'Default wrapper',
        html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{{page.title}}</title>
  {{>head}}
</head>
<body>
  <main>
    {{>page_body}}
  </main>
</body>
</html>`,
      });
    if (wrapperRes.error) {
      return { libraryId: null, error: `Wrapper insert failed: ${wrapperRes.error.message}` };
    }

    // 3. inline source — anchors the content schema. Required because
    // templates_content_schemas has a NOT NULL FK to templates_sources.
    // The check constraint `templates_sources_inline_fields` requires
    // both inline_html AND inline_sha to be set when kind='inline';
    // inline_sha must be the SHA-256 of inline_html (64-hex).
    const inlineHtml = '';
    const inlineSha = await sha256Hex(inlineHtml);
    const sourceRes = await supabase
      .from('templates_sources')
      .insert({
        library_id: libraryId,
        kind: 'inline',
        label: 'Inline starter',
        status: 'active',
        theme_kind: args.themeKind,
        inline_html: inlineHtml,
        inline_sha: inlineSha,
        auto_apply: false,
      })
      .select('id')
      .single();
    if (sourceRes.error || !sourceRes.data) {
      return { libraryId: null, error: `Source insert failed: ${sourceRes.error?.message ?? 'no_data'}` };
    }
    const sourceId = sourceRes.data.id as string;

    // 4. content schema — a minimal hero + sections shape so the schema
    // editor renders something useful out of the box. Replaced when an
    // operator connects a real git source via the Source tab.
    const schemaJson = STARTER_CONTENT_SCHEMA_JSON;
    const schemaHash = await sha256Hex(JSON.stringify(schemaJson));
    const schemaRes = await supabase
      .from('templates_content_schemas')
      .insert({
        source_id: sourceId,
        library_id: libraryId,
        version: 1,
        is_current: true,
        schema_format: 'json',
        schema_hash: schemaHash,
        schema_json: schemaJson,
      });
    if (schemaRes.error) {
      return { libraryId: null, error: `Content schema insert failed: ${schemaRes.error.message}` };
    }

    // 5. point the site at it
    const updateRes = await supabase
      .from('sites')
      .update({ templates_library_id: libraryId })
      .eq('id', args.siteId);
    if (updateRes.error) {
      return { libraryId: null, error: `Site update failed: ${updateRes.error.message}` };
    }

    return { libraryId, error: null };
  },
};

// ---------------------------------------------------------------------------
// Pages (within a site)
// ---------------------------------------------------------------------------

export interface PageSummary {
  id: string;
  slug: string;
  full_path: string;
  title: string;
  status: 'draft' | 'scheduled' | 'published' | 'archived';
  is_homepage: boolean;
  version: number;
  published_version: number;
  updated_at: string;
}

export const PagesService = {
  async listPages(siteId: string): Promise<{ pages: PageSummary[]; error: string | null }> {
    const { data, error } = await supabase
      .from('pages')
      .select('id, slug, full_path, title, status, is_homepage, version, published_version, updated_at')
      .eq('host_kind', 'site')
      .eq('host_id', siteId)
      .neq('status', 'archived')
      .order('full_path', { ascending: true });
    if (error) return { pages: [], error: error.message };
    return { pages: (data ?? []) as PageSummary[], error: null };
  },

  async getPage(pageId: string): Promise<{ page: PageRow | null; error: string | null }> {
    const { data, error } = await supabase
      .from('pages')
      .select('*')
      .eq('id', pageId)
      .maybeSingle();
    if (error) return { page: null, error: error.message };
    return { page: data as PageRow | null, error: null };
  },

  async createPage(args: {
    siteId: string;
    templates_library_id: string;
    slug: string;
    full_path: string;
    title: string;
    is_homepage?: boolean;
    /**
     * Per spec-content-modules-git-architecture §8.3.
     * 'schema' (default) — pages.content JSONB conforming to the route schema.
     * 'blocks' — page_blocks + page_block_bricks ordered list (legacy block-list).
     * Immutable post-create.
     */
    composition_mode?: 'schema' | 'blocks';
  }): Promise<{ page: PageRow | null; error: string | null }> {
    const apiUrl = (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    const res = await fetch(`${apiUrl}/api/modules/sites/admin/pages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        host_kind: 'site',
        host_id: args.siteId,
        templates_library_id: args.templates_library_id,
        slug: args.slug,
        full_path: args.full_path,
        title: args.title,
        is_homepage: args.is_homepage ?? false,
        composition_mode: args.composition_mode ?? 'schema',
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { page: null, error: body?.error?.message ?? `Failed (${res.status})` };
    }
    const created = await res.json();
    return { page: created as PageRow, error: null };
  },

  async archivePage(pageId: string): Promise<{ error: string | null }> {
    const apiUrl = (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    const res = await fetch(`${apiUrl}/api/modules/sites/admin/pages/${pageId}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: body?.error?.message ?? `Failed (${res.status})` };
    }
    return { error: null };
  },
};

// ---------------------------------------------------------------------------
// Publish jobs (publishing tab status)
// ---------------------------------------------------------------------------

export interface PublishJobSummary {
  id: string;
  page_id: string | null;
  publisher_id: string;
  status: SitesPublishJobRow['status'];
  result_pr_url: string | null;
  result_deployment_url: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  created_at: string;
}

export const PublishJobsService = {
  async listForSite(siteId: string, limit = 25): Promise<{ jobs: PublishJobSummary[]; error: string | null }> {
    const { data, error } = await supabase
      .from('sites_publish_jobs')
      .select('id, page_id, publisher_id, status, result_pr_url, result_deployment_url, started_at, finished_at, error, created_at')
      .eq('site_id', siteId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return { jobs: [], error: error.message };
    return { jobs: (data ?? []) as PublishJobSummary[], error: null };
  },

  /**
   * Trigger a publish for the whole site. Hits the republish-routes
   * endpoint mounted at /api/admin/sites/:siteId/publish (per spec
   * §republish §6.1). The publish-worker picks up the queued job and runs
   * the build → commit → deploy chain.
   */
  async publishSite(
    siteId: string,
    opts: { reason?: string; force?: boolean } = {},
  ): Promise<{ publishId: string | null; error: string | null }> {
    const apiUrl = (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    const res = await fetch(`${apiUrl}/api/admin/sites/${siteId}/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        reason: opts.reason ?? 'admin-triggered',
        force: opts.force ?? false,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { publishId: null, error: body?.error?.message ?? body?.message ?? `Failed (${res.status})` };
    }
    const body = (await res.json()) as { publishId: string };
    return { publishId: body.publishId, error: null };
  },

  /**
   * Roll back to a prior succeeded publish job — clones its content snapshot
   * into a new queued job. POST /api/modules/sites/admin/sites/:siteId/publish-jobs/:jobId/rollback.
   */
  async rollback(siteId: string, jobId: string): Promise<{ newJobId: string | null; error: string | null }> {
    const apiUrl = (import.meta as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? '';
    const { data: session } = await supabase.auth.getSession();
    const token = session.session?.access_token;
    const res = await fetch(
      `${apiUrl}/api/modules/sites/admin/sites/${siteId}/publish-jobs/${jobId}/rollback`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { newJobId: null, error: body?.error?.message ?? `Failed (${res.status})` };
    }
    const created = (await res.json()) as { id: string };
    return { newJobId: created.id, error: null };
  },
};

// ---------------------------------------------------------------------------
// Templates libraries (for the "templates_library_id" picker on page create)
// ---------------------------------------------------------------------------

export interface TemplatesLibrarySummary {
  id: string;
  name: string;
  host_kind: string;
  theme_kind: ThemeKind;
}

// ---------------------------------------------------------------------------
// A/B tests (per-site experiments)
// ---------------------------------------------------------------------------

export type AbScopeKind = 'page' | 'block_instance' | 'edition' | 'layout';
export type AbTestStatus = 'draft' | 'running' | 'paused' | 'concluded';

export interface AbVariant {
  key: string;
  weight: number;
}

export interface AbTestRow {
  id: string;
  scope_kind: AbScopeKind;
  scope_id: string;
  host_kind: string;
  host_id: string | null;
  name: string;
  variants: AbVariant[];
  goal_event: string;
  status: AbTestStatus;
  engine_id: string;
  started_at: string | null;
  ended_at: string | null;
  winner_variant: string | null;
  created_at: string;
}

export interface AbTestSummary extends AbTestRow {
  /** Per-variant counts derived from templates_ab_events. */
  variantStats: Array<{ key: string; impressions: number; conversions: number }>;
}

export const AbTestsService = {
  async listForSite(siteId: string): Promise<{ tests: AbTestSummary[]; error: string | null }> {
    const { data: tests, error } = await supabase
      .from('templates_ab_tests')
      .select('*')
      .eq('host_kind', 'site')
      .eq('host_id', siteId)
      .order('created_at', { ascending: false });
    if (error) return { tests: [], error: error.message };

    const out: AbTestSummary[] = [];
    for (const t of (tests ?? []) as AbTestRow[]) {
      // Per-variant rollups. One round-trip per test is fine for the
      // expected handful of tests per site; if this grows, an aggregate
      // RPC supersedes it.
      const { data: events } = await supabase
        .from('templates_ab_events')
        .select('variant, kind')
        .eq('test_id', t.id);
      const counts = new Map<string, { impressions: number; conversions: number }>();
      for (const v of t.variants) counts.set(v.key, { impressions: 0, conversions: 0 });
      for (const e of (events ?? []) as Array<{ variant: string; kind: 'impression' | 'conversion' }>) {
        const c = counts.get(e.variant);
        if (!c) continue;
        if (e.kind === 'impression') c.impressions += 1;
        else c.conversions += 1;
      }
      out.push({
        ...t,
        variantStats: Array.from(counts, ([key, v]) => ({ key, ...v })),
      });
    }
    return { tests: out, error: null };
  },

  async createTest(args: {
    siteId: string;
    scope_kind: AbScopeKind;
    scope_id: string;
    name: string;
    variants: AbVariant[];
    goal_event: string;
  }): Promise<{ test: AbTestRow | null; error: string | null }> {
    const totalWeight = args.variants.reduce((s, v) => s + v.weight, 0);
    if (Math.abs(totalWeight - 100) > 0.001) {
      return { test: null, error: `variant weights must sum to 100 (got ${totalWeight})` };
    }
    if (args.variants.length < 2) {
      return { test: null, error: 'at least 2 variants required' };
    }
    const { data, error } = await supabase
      .from('templates_ab_tests')
      .insert({
        scope_kind: args.scope_kind,
        scope_id: args.scope_id,
        host_kind: 'site',
        host_id: args.siteId,
        name: args.name,
        variants: args.variants,
        goal_event: args.goal_event,
        status: 'draft',
        engine_id: 'builtin',
      })
      .select('*')
      .single<AbTestRow>();
    if (error || !data) return { test: null, error: error?.message ?? 'insert failed' };
    return { test: data, error: null };
  },

  async setStatus(
    testId: string,
    status: AbTestStatus,
    extra?: { winner_variant?: string },
  ): Promise<{ error: string | null }> {
    const patch: Record<string, unknown> = { status };
    if (status === 'running') patch.started_at = new Date().toISOString();
    if (status === 'concluded') {
      patch.ended_at = new Date().toISOString();
      if (extra?.winner_variant) patch.winner_variant = extra.winner_variant;
    }
    const { error } = await supabase
      .from('templates_ab_tests')
      .update(patch)
      .eq('id', testId);
    return { error: error?.message ?? null };
  },

  async deleteTest(testId: string): Promise<{ error: string | null }> {
    const { error } = await supabase
      .from('templates_ab_tests')
      .delete()
      .eq('id', testId);
    return { error: error?.message ?? null };
  },

  /**
   * Promote a variant's content to the page's default. Used after concluding
   * a test: the winner's `pages_content_variants.content` row gets copied
   * into `pages.content`, then the test is concluded with `winner_variant`
   * set. The variant rows themselves stay (history); a follow-up publish
   * picks up the new default.
   */
  async promoteWinner(args: {
    testId: string;
    pageId: string;
    variant: string;
  }): Promise<{ error: string | null }> {
    // 1. Read variant content row
    const { data: variantRows, error: vErr } = await supabase
      .from('pages_content_variants')
      .select('id, match_context, content')
      .eq('page_id', args.pageId)
      .eq('field_path', '/');
    if (vErr) return { error: vErr.message };
    const winner = ((variantRows ?? []) as Array<{ id: string; match_context: Record<string, unknown>; content: Record<string, unknown> }>).find(
      (r) => r.match_context?.ab_test_id === args.testId && r.match_context?.variant === args.variant,
    );
    if (!winner) return { error: `no content stored for variant "${args.variant}"` };

    // 2. Swap into pages.content
    const { error: pErr } = await supabase
      .from('pages')
      .update({ content: winner.content })
      .eq('id', args.pageId);
    if (pErr) return { error: pErr.message };

    // 3. Conclude the test (records winner_variant + ended_at)
    const { error: tErr } = await supabase
      .from('templates_ab_tests')
      .update({
        status: 'concluded',
        ended_at: new Date().toISOString(),
        winner_variant: args.variant,
      })
      .eq('id', args.testId);
    if (tErr) return { error: tErr.message };

    return { error: null };
  },
};

// ---------------------------------------------------------------------------
// Per-variant page content (pages_content_variants). The renderer emits
// content/pages/<slug>.<variant>.json files; the bootstrap script picks the
// variant after assignment and exposes it at window.gatewazeAB.variantContent.
//
// Stored shape: one row per (page_id, test, variant) with field_path='/' and
// content = the full content blob for that variant. Future per-field
// personalization uses the same table with different field_path values.
// ---------------------------------------------------------------------------

export interface AbVariantContentRow {
  /** Variant key — matches templates_ab_tests.variants[].key. */
  variant: string;
  /** The variant's content blob (same shape as pages.content). */
  content: Record<string, unknown>;
}

export const AbVariantsService = {
  /**
   * List variant content blobs for a test. Returns one entry per variant
   * that has been authored so far (variants without a row are absent — the
   * renderer falls back to the page's default content for those).
   */
  async listForTest(
    pageId: string,
    testId: string,
  ): Promise<{ variants: AbVariantContentRow[]; error: string | null }> {
    const { data, error } = await supabase
      .from('pages_content_variants')
      .select('match_context, content')
      .eq('page_id', pageId)
      .eq('field_path', '/');
    if (error) return { variants: [], error: error.message };

    const out: AbVariantContentRow[] = [];
    for (const row of (data ?? []) as Array<{ match_context: Record<string, unknown>; content: Record<string, unknown> }>) {
      if (row.match_context?.ab_test_id !== testId) continue;
      const variant = typeof row.match_context.variant === 'string' ? row.match_context.variant : null;
      if (!variant) continue;
      out.push({ variant, content: row.content });
    }
    return { variants: out, error: null };
  },

  /**
   * Upsert variant content. The (page_id, field_path, match_context_hash)
   * UNIQUE constraint dedupes per variant; we use raw SQL via .upsert with
   * onConflict to land on the natural key.
   */
  async upsertVariantContent(args: {
    pageId: string;
    testId: string;
    variant: string;
    content: Record<string, unknown>;
    variantLabel?: string;
  }): Promise<{ error: string | null }> {
    const matchContext = { ab_test_id: args.testId, variant: args.variant };
    const { error } = await supabase
      .from('pages_content_variants')
      .upsert(
        {
          page_id: args.pageId,
          field_path: '/',
          match_context: matchContext,
          content: args.content,
          variant_label: args.variantLabel ?? args.variant,
        },
        { onConflict: 'page_id,field_path,match_context_hash' },
      );
    return { error: error?.message ?? null };
  },

  async deleteVariantContent(args: {
    pageId: string;
    testId: string;
    variant: string;
  }): Promise<{ error: string | null }> {
    // No clean way to .eq() on a JSONB sub-key with PostgREST without an RPC;
    // load + delete by id instead. Small N (one row per variant per page).
    const { data } = await supabase
      .from('pages_content_variants')
      .select('id, match_context')
      .eq('page_id', args.pageId)
      .eq('field_path', '/');
    const target = ((data ?? []) as Array<{ id: string; match_context: Record<string, unknown> }>).find(
      (r) => r.match_context?.ab_test_id === args.testId && r.match_context?.variant === args.variant,
    );
    if (!target) return { error: null };
    const { error } = await supabase.from('pages_content_variants').delete().eq('id', target.id);
    return { error: error?.message ?? null };
  },
};

export const TemplatesLibrariesService = {
  /** Lists libraries that can host pages for a site of the given theme_kind. */
  async listForSite(themeKind: ThemeKind): Promise<{ libraries: TemplatesLibrarySummary[]; error: string | null }> {
    const { data, error } = await supabase
      .from('templates_libraries')
      .select('id, name, host_kind, theme_kind')
      .eq('theme_kind', themeKind)
      .order('name');
    if (error) return { libraries: [], error: error.message };
    return { libraries: (data ?? []) as TemplatesLibrarySummary[], error: null };
  },
};
