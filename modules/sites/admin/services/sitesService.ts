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

    // Auto-provision a starter library so the user can immediately
    // create pages. Failure here is non-fatal — the site exists; the
    // user can re-trigger via the "Provision starter templates" button
    // on the Pages tab.
    const provision = await SitesService.provisionStarterLibrary({
      siteId: (data as SiteRow).id,
      siteName: (data as SiteRow).name,
      themeKind: (data as SiteRow).theme_kind,
    });
    if (provision.error) {
      // eslint-disable-next-line no-console
      console.warn('[sites] starter library auto-provision failed:', provision.error);
    }

    // Re-read so the caller sees the updated templates_library_id.
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

  async archiveSite(siteId: string): Promise<{ error: string | null }> {
    const { error } = await supabase
      .from('sites')
      .update({ status: 'archived' })
      .eq('id', siteId);
    return { error: error?.message ?? null };
  },

  /**
   * Provision a starter templates_library for a site, plus a default
   * wrapper and a couple of starter block defs, then assign the new
   * library_id back onto sites.templates_library_id. No-op if the site
   * already has one.
   *
   * Steps (browser-side, RLS gates each via is_admin() per migrations
   * 008/011 + the host_kind='site' registration in 009):
   *   1. INSERT templates_libraries (host_kind='site', host_id=siteId)
   *   2. INSERT templates_wrappers (key='default', html with {{>page_body}})
   *   3. INSERT templates_block_defs (heading + paragraph starters)
   *   4. UPDATE sites.templates_library_id
   *
   * Returns the library_id on success.
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

    const blockDefs = [
      {
        library_id: libraryId,
        key: 'heading',
        name: 'Heading',
        description: 'Single heading element',
        source_kind: 'static',
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string', title: 'Text' },
            level: { type: 'string', enum: ['h1', 'h2', 'h3'], default: 'h2', title: 'Level' },
          },
        },
        html: '<{{level}}>{{text}}</{{level}}>',
        has_bricks: false,
        version: 1,
        is_current: true,
      },
      {
        library_id: libraryId,
        key: 'paragraph',
        name: 'Paragraph',
        description: 'Body text with rich HTML',
        source_kind: 'static',
        schema: {
          type: 'object',
          properties: { body: { type: 'string', format: 'html', title: 'Body' } },
        },
        html: '<p>{{{body}}}</p>',
        has_bricks: false,
        version: 1,
        is_current: true,
      },
    ];
    const blocksRes = await supabase.from('templates_block_defs').insert(blockDefs);
    if (blocksRes.error) {
      return { libraryId: null, error: `Block defs insert failed: ${blocksRes.error.message}` };
    }

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
