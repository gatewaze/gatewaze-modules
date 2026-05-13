/**
 * Public site-navigation + site-settings endpoints.
 *
 * Mounted on the sites module's public router (no JWT required). Themes
 * call these from their server components at build / render time to
 * resolve the header / footer menus and brand-level settings (logo,
 * socials, copyright) instead of hardcoding them.
 *
 * Endpoints:
 *   GET /api/sites/:siteSlug/navigation/:menuSlug
 *     Returns the menu's tree (nested by parent_id). Filters out items
 *     with visibility='authenticated_only' since no JWT is presented.
 *
 *   GET /api/sites/:siteSlug/settings
 *     Returns brand-level settings sourced from sites.config (branding /
 *     socials) with conservative defaults when fields are missing.
 *
 * Cache: Cache-Control public, max-age=60, s-maxage=300. The data is
 * read-mostly and a 60-second skew between admin edit and theme view
 * is acceptable.
 *
 * Per spec-aaif-theme-deliverable §7 (public read APIs for themes).
 */

import { createHash } from 'node:crypto';

import type { Request, Response, Router } from 'express';

interface ErrorEnvelope {
  error: string;
  message: string;
}

interface MenuRow {
  id: string;
  slug: string;
  name: string;
}

interface MenuItemRow {
  id: string;
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

interface PageLookupRow {
  id: string;
  slug: string;
  full_path: string;
}

interface SiteRow {
  id: string;
  slug: string;
  name: string;
  config: Record<string, unknown> | null;
}

interface HostMediaRow {
  id: string;
  storage_path: string;
  filename: string;
  mime_type: string;
}

/** Resolved item shape — fields the theme actually consumes. */
interface ResolvedMenuItem {
  id: string;
  parent_id: string | null;
  order_index: number;
  label: string;
  page_slug: string | null;
  external_url: string | null;
  anchor_target: string | null;
  open_in_new_tab: boolean;
  rel_attributes: string[];
  css_classes: string | null;
  visibility: 'always' | 'public_only';
  children: ResolvedMenuItem[];
}

function paramAs(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return undefined;
}

/**
 * Slug validator — restricts to letters / digits / dash / underscore.
 * Keeps user-supplied path segments out of PostgREST .eq() values where
 * downstream behaviour could be surprising. Per security-boundaries §3.
 */
function isValidSlug(s: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(s) && s.length <= 128;
}

const CACHE_HEADER = 'public, max-age=60, s-maxage=300, stale-if-error=86400';

/**
 * Emit a cacheable response with the headers the Layer-3 CDN expects:
 *
 *   Cache-Control:  public, max-age=60, s-maxage=300, stale-if-error=86400
 *   Surrogate-Key:  <topic> [<topic>:<id-or-slug> ...]
 *   ETag:           W/"<sha256(body)[0:16]>"
 *
 * Spec: §5.4 of spec-api-cache-and-revalidation.md.
 *
 * If the client's `If-None-Match` matches the computed ETag we return
 * 304 with no body (origin bandwidth save inside the max-age window).
 */
function sendCacheable(
  req: Request,
  res: Response,
  body: unknown,
  surrogateKeys: string[],
): void {
  const json = JSON.stringify(body);
  const etag = `W/"${createHash('sha256').update(json).digest('hex').slice(0, 16)}"`;
  res.setHeader('Cache-Control', CACHE_HEADER);
  res.setHeader('Surrogate-Key', surrogateKeys.join(' '));
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.status(200).type('application/json').send(json);
}

export interface PublicMenusRoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any };
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Browser-facing supabase URL (for building host_media public URLs). */
  supabasePublicUrl: string;
  /** Storage bucket name; defaults to 'media'. */
  storageBucket: string;
}

export function createPublicMenusRoutes(deps: PublicMenusRoutesDeps) {
  const { supabase, logger, supabasePublicUrl, storageBucket } = deps;

  const buildPublicUrl = (storagePath: string): string =>
    `${supabasePublicUrl.replace(/\/+$/, '')}/storage/v1/object/public/${storageBucket}/${storagePath}`;

  /** Resolve siteSlug → site row. */
  async function loadSite(siteSlug: string): Promise<SiteRow | null> {
    const result = await supabase
      .from('sites')
      .select('id, slug, name, config')
      .eq('slug', siteSlug)
      .maybeSingle();
    return (result as { data: SiteRow | null }).data ?? null;
  }

  /** Resolve siteId+menuSlug → menu row. */
  async function loadMenu(siteId: string, menuSlug: string): Promise<MenuRow | null> {
    const result = await supabase
      .from('navigation_menus')
      .select('id, slug, name')
      .eq('host_kind', 'site')
      .eq('host_id', siteId)
      .eq('slug', menuSlug)
      .maybeSingle();
    return (result as { data: MenuRow | null }).data ?? null;
  }

  async function loadMenuItems(menuId: string): Promise<MenuItemRow[]> {
    const result = await supabase
      .from('navigation_menu_items')
      .select(
        'id, parent_id, order_index, label, page_id, external_url, anchor_target, open_in_new_tab, rel_attributes, css_classes, visibility',
      )
      .eq('menu_id', menuId)
      .order('order_index');
    return ((result as { data: MenuItemRow[] | null }).data) ?? [];
  }

  async function loadPagesByIds(pageIds: string[]): Promise<Map<string, PageLookupRow>> {
    if (pageIds.length === 0) return new Map();
    const result = await supabase
      .from('pages')
      .select('id, slug, full_path')
      .in('id', pageIds);
    const rows = (((result as { data: PageLookupRow[] | null }).data) ?? []);
    const map = new Map<string, PageLookupRow>();
    for (const r of rows) map.set(r.id, r);
    return map;
  }

  /**
   * Build a nested tree from a flat list. Filters out authenticated_only
   * items recursively (a hidden parent hides its subtree).
   */
  function buildTree(
    items: MenuItemRow[],
    pagesById: Map<string, PageLookupRow>,
  ): ResolvedMenuItem[] {
    const visible = items.filter((i) => i.visibility !== 'authenticated_only');

    const resolveItem = (row: MenuItemRow): ResolvedMenuItem => {
      const page = row.page_id ? pagesById.get(row.page_id) : null;
      return {
        id: row.id,
        parent_id: row.parent_id,
        order_index: row.order_index,
        label: row.label,
        page_slug: page?.slug ?? null,
        external_url: row.external_url,
        anchor_target: row.anchor_target,
        open_in_new_tab: row.open_in_new_tab,
        rel_attributes: row.rel_attributes ?? [],
        css_classes: row.css_classes,
        // Narrow: authenticated_only is filtered above.
        visibility: row.visibility === 'public_only' ? 'public_only' : 'always',
        children: [],
      };
    };

    const byId = new Map<string, ResolvedMenuItem>();
    for (const r of visible) byId.set(r.id, resolveItem(r));

    const roots: ResolvedMenuItem[] = [];
    for (const r of visible) {
      const resolved = byId.get(r.id)!;
      if (r.parent_id && byId.has(r.parent_id)) {
        byId.get(r.parent_id)!.children.push(resolved);
      } else {
        // Either a top-level item, or its parent was filtered out — in
        // the latter case we promote the orphan rather than drop it, so
        // a public_only parent of a public_only child doesn't hide both.
        roots.push(resolved);
      }
    }

    // Ensure children at each level retain order_index order. The flat
    // list arrives sorted, but iteration order through Map preserves
    // insertion-order which mirrors that. Belt-and-suspenders sort:
    const sortChildren = (node: ResolvedMenuItem): void => {
      node.children.sort((a, b) => a.order_index - b.order_index);
      for (const c of node.children) sortChildren(c);
    };
    roots.sort((a, b) => a.order_index - b.order_index);
    for (const r of roots) sortChildren(r);

    return roots;
  }

  async function getNavigation(req: Request, res: Response): Promise<void> {
    const siteSlug = paramAs(req.params.siteSlug);
    const menuSlug = paramAs(req.params.menuSlug);
    if (!siteSlug || !menuSlug) {
      res.status(400).json({ error: 'missing_params', message: 'siteSlug and menuSlug required' } satisfies ErrorEnvelope);
      return;
    }
    if (!isValidSlug(siteSlug) || !isValidSlug(menuSlug)) {
      res.status(400).json({ error: 'invalid_slug', message: 'slugs must be [A-Za-z0-9_-]{1,128}' } satisfies ErrorEnvelope);
      return;
    }

    const site = await loadSite(siteSlug);
    if (!site) {
      res.status(404).json({ error: 'site_not_found', message: `no site '${siteSlug}'` } satisfies ErrorEnvelope);
      return;
    }
    const menu = await loadMenu(site.id, menuSlug);
    if (!menu) {
      res.status(404).json({ error: 'menu_not_found', message: `no menu '${menuSlug}' for site '${siteSlug}'` } satisfies ErrorEnvelope);
      return;
    }

    const items = await loadMenuItems(menu.id);
    const pageIds = items
      .map((i) => i.page_id)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    const pagesById = await loadPagesByIds(pageIds);

    const tree = buildTree(items, pagesById);

    sendCacheable(
      req,
      res,
      {
        menu: { id: menu.id, slug: menu.slug, name: menu.name },
        items: tree,
      },
      ['navigation', `navigation:${siteSlug}:${menuSlug}`],
    );
  }

  /**
   * Look up the site's primary logo from host_media. Falls back to null
   * when no logo asset is registered.
   *
   * Convention: filenames containing `secondary-logo-black` are the
   * header (on-light) logo; `secondary-logo-white` is the footer (on-
   * dark) logo. Operators can override either by setting
   * sites.config.branding.{header_logo,footer_logo} to a {url,alt} pair.
   */
  async function loadSiteLogos(siteId: string): Promise<{
    header: { url: string; alt: string } | null;
    footer: { url: string; alt: string } | null;
    favicon: { url: string } | null;
  }> {
    const result = await supabase
      .from('host_media')
      .select('id, storage_path, filename, mime_type')
      .eq('host_kind', 'site')
      .eq('host_id', siteId);
    const rows = (((result as { data: HostMediaRow[] | null }).data) ?? []);

    const findByPattern = (pattern: RegExp): HostMediaRow | null =>
      rows.find((r) => pattern.test(r.filename)) ?? null;

    const headerRow = findByPattern(/logo.*black|black.*logo|secondary-logo-black|primary-logo/i);
    const footerRow = findByPattern(/logo.*white|white.*logo|secondary-logo-white/i) ?? headerRow;
    const faviconRow = findByPattern(/favicon|icon\.(png|svg|ico)/i);

    return {
      header: headerRow
        ? { url: buildPublicUrl(headerRow.storage_path), alt: '' }
        : null,
      footer: footerRow
        ? { url: buildPublicUrl(footerRow.storage_path), alt: '' }
        : null,
      favicon: faviconRow ? { url: buildPublicUrl(faviconRow.storage_path) } : null,
    };
  }

  async function getSettings(req: Request, res: Response): Promise<void> {
    const siteSlug = paramAs(req.params.siteSlug);
    if (!siteSlug) {
      res.status(400).json({ error: 'missing_params', message: 'siteSlug required' } satisfies ErrorEnvelope);
      return;
    }
    if (!isValidSlug(siteSlug)) {
      res.status(400).json({ error: 'invalid_slug', message: 'slug must be [A-Za-z0-9_-]{1,128}' } satisfies ErrorEnvelope);
      return;
    }

    const site = await loadSite(siteSlug);
    if (!site) {
      res.status(404).json({ error: 'site_not_found', message: `no site '${siteSlug}'` } satisfies ErrorEnvelope);
      return;
    }

    // sites.config.branding override shape (any field may be omitted):
    //   { header_logo: {url, alt}, footer_logo: {url, alt},
    //     favicon: {url}, socials: {x, linkedin, ...}, copyright: '...',
    //     linux_foundation_banner: bool }
    const config = (site.config ?? {}) as {
      branding?: {
        header_logo?: { url?: string; alt?: string };
        footer_logo?: { url?: string; alt?: string };
        favicon?: { url?: string };
        socials?: {
          x?: string | null;
          linkedin?: string | null;
          github?: string | null;
          youtube?: string | null;
          discord?: string | null;
        };
        copyright?: string;
        linux_foundation_banner?: boolean;
      };
    };
    const branding = config.branding ?? {};

    // Logos: branding overrides win; otherwise sniff host_media. The
    // resolved {url,alt} is what themes render directly.
    const logos = await loadSiteLogos(site.id);
    const resolvedHeaderLogo = branding.header_logo?.url
      ? { url: branding.header_logo.url, alt: branding.header_logo.alt ?? site.name }
      : logos.header
        ? { url: logos.header.url, alt: site.name }
        : null;
    const resolvedFooterLogo = branding.footer_logo?.url
      ? { url: branding.footer_logo.url, alt: branding.footer_logo.alt ?? site.name }
      : logos.footer
        ? { url: logos.footer.url, alt: site.name }
        : resolvedHeaderLogo;
    const resolvedFavicon = branding.favicon?.url
      ? { url: branding.favicon.url }
      : logos.favicon ?? null;

    // Socials: branding wins, otherwise default to null per field. The
    // AAIF-specific hardcoded defaults below cover the pre-migration
    // values; they apply only to the 'aaif' slug to avoid leaking AAIF
    // socials onto other sites that share this module.
    const defaultSocials =
      siteSlug === 'aaif'
        ? {
            x: 'https://twitter.com/aaif',
            linkedin: 'https://linkedin.com/company/agentic-ai-foundation',
            github: 'https://github.com/agentic-ai-foundation',
            youtube: null as string | null,
            discord: null as string | null,
          }
        : { x: null, linkedin: null, github: null, youtube: null, discord: null };
    const socials = branding.socials
      ? { ...defaultSocials, ...branding.socials }
      : defaultSocials;

    const defaultCopyright =
      siteSlug === 'aaif'
        ? `© ${new Date().getUTCFullYear()} Agentic AI Foundation. A Linux Foundation Project.`
        : `© ${new Date().getUTCFullYear()} ${site.name}`;
    const copyright = branding.copyright ?? defaultCopyright;

    sendCacheable(
      req,
      res,
      {
        site: { id: site.id, slug: site.slug, name: site.name },
        logo: resolvedHeaderLogo,
        footer_logo: resolvedFooterLogo,
        favicon: resolvedFavicon,
        socials,
        copyright,
        linux_foundation_banner:
          branding.linux_foundation_banner ?? (siteSlug === 'aaif'),
      },
      ['site_settings', `site_settings:${siteSlug}`],
    );

    void logger; // reserved for future audit log emission
  }

  return { getNavigation, getSettings };
}

export function mountPublicMenusRoutes(
  router: Router,
  routes: ReturnType<typeof createPublicMenusRoutes>,
): void {
  router.get('/sites/:siteSlug/navigation/:menuSlug', routes.getNavigation);
  router.get('/sites/:siteSlug/settings', routes.getSettings);
}
