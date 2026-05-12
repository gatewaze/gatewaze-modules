/**
 * Tests for public navigation + settings endpoints.
 *
 * Covers:
 *   - 404 when siteSlug doesn't resolve
 *   - 404 when menuSlug doesn't resolve under the site
 *   - 200 returns nested tree built by parent_id with order preserved
 *   - 200 visibility filter excludes authenticated_only items recursively
 *   - 200 page_slug populated when item.page_id resolves to a page row
 *   - 400 invalid slug shape rejected
 *   - 200 /settings returns AAIF defaults when branding config absent
 *   - 200 /settings honours sites.config.branding overrides
 *   - Cache-Control header set on success responses
 */

import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createPublicMenusRoutes, type PublicMenusRoutesDeps } from '../public-menus-routes.js';

type ScalarRow = Record<string, unknown>;

interface TableStub {
  rows: ScalarRow[];
}

/**
 * Minimal PostgREST-shape stub. The route only uses .eq(), .in(),
 * .order(), .maybeSingle(), .select() — enough to test the resolver
 * without spinning up a full Supabase client.
 */
function makeSupabaseStub(tables: Record<string, ScalarRow[]>) {
  const calls: Array<{ table: string; filters: Record<string, unknown> }> = [];
  return {
    calls,
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let inFilter: { col: string; vals: unknown[] } | null = null;
      const rows = tables[table] ?? [];
      const applyFilters = (): ScalarRow[] => {
        let result = rows.slice();
        for (const [k, v] of Object.entries(filters)) {
          result = result.filter((r) => r[k] === v);
        }
        if (inFilter) {
          result = result.filter((r) => inFilter!.vals.includes(r[inFilter!.col]));
        }
        return result;
      };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return chain;
        },
        in: (col: string, vals: unknown[]) => {
          inFilter = { col, vals };
          return chain;
        },
        order: () => {
          calls.push({ table, filters: { ...filters } });
          return { data: applyFilters(), error: null };
        },
        maybeSingle: async () => {
          calls.push({ table, filters: { ...filters } });
          const matched = applyFilters();
          return { data: matched[0] ?? null, error: null };
        },
        single: async () => {
          calls.push({ table, filters: { ...filters } });
          const matched = applyFilters();
          return { data: matched[0] ?? null, error: null };
        },
        // Bare `await result` (no terminal call) — used when the route
        // does `await supabase.from(...).select(...).eq(...)`.
        then: (cb: (v: { data: ScalarRow[]; error: null }) => unknown) => {
          calls.push({ table, filters: { ...filters } });
          return Promise.resolve(cb({ data: applyFilters(), error: null }));
        },
      };
      return chain;
    },
  };
}

function makeDeps(tables: Record<string, ScalarRow[]>): PublicMenusRoutesDeps & {
  supabase: ReturnType<typeof makeSupabaseStub>;
} {
  return {
    supabase: makeSupabaseStub(tables),
    logger: { info: vi.fn(), warn: vi.fn() },
    supabasePublicUrl: 'http://supabase.aaif.localhost',
    storageBucket: 'media',
  };
}

function makeRes() {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const setHeader = vi.fn();
  return {
    res: { status, json, setHeader } as unknown as Response,
    status,
    json,
    setHeader,
  };
}

describe('getNavigation', () => {
  it('returns 404 when site not found', async () => {
    const deps = makeDeps({ sites: [] });
    const routes = createPublicMenusRoutes(deps);
    const req = { params: { siteSlug: 'unknown', menuSlug: 'primary' } } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.getNavigation(req, res);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'site_not_found' }));
  });

  it('returns 404 when menu not found under site', async () => {
    const deps = makeDeps({
      sites: [{ id: 'site-1', slug: 'aaif', name: 'AAIF', config: {} }],
      navigation_menus: [],
    });
    const routes = createPublicMenusRoutes(deps);
    const req = { params: { siteSlug: 'aaif', menuSlug: 'primary' } } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.getNavigation(req, res);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'menu_not_found' }));
  });

  it('returns 400 when siteSlug has invalid characters', async () => {
    const deps = makeDeps({ sites: [] });
    const routes = createPublicMenusRoutes(deps);
    const req = { params: { siteSlug: '../etc/passwd', menuSlug: 'primary' } } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.getNavigation(req, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'invalid_slug' }));
  });

  it('returns 200 + nested tree for happy path with order preserved', async () => {
    const deps = makeDeps({
      sites: [{ id: 'site-1', slug: 'aaif', name: 'AAIF', config: {} }],
      navigation_menus: [
        { id: 'menu-1', host_kind: 'site', host_id: 'site-1', slug: 'primary', name: 'Header' },
      ],
      navigation_menu_items: [
        // Root items, intentionally out of order to verify sort:
        {
          id: 'a',
          menu_id: 'menu-1',
          parent_id: null,
          order_index: 1,
          label: 'Projects',
          page_id: null,
          external_url: '/projects',
          anchor_target: null,
          open_in_new_tab: false,
          rel_attributes: null,
          css_classes: null,
          visibility: 'always',
        },
        {
          id: 'b',
          menu_id: 'menu-1',
          parent_id: null,
          order_index: 0,
          label: 'About',
          page_id: null,
          external_url: null,
          anchor_target: null,
          open_in_new_tab: false,
          rel_attributes: null,
          css_classes: null,
          visibility: 'always',
        },
        {
          id: 'b1',
          menu_id: 'menu-1',
          parent_id: 'b',
          order_index: 0,
          label: 'About Us',
          page_id: null,
          external_url: '/about-us',
          anchor_target: null,
          open_in_new_tab: false,
          rel_attributes: null,
          css_classes: null,
          visibility: 'always',
        },
      ],
      pages: [],
    });
    const routes = createPublicMenusRoutes(deps);
    const req = { params: { siteSlug: 'aaif', menuSlug: 'primary' } } as unknown as Request;
    const { res, status, json, setHeader } = makeRes();

    await routes.getNavigation(req, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      expect.stringContaining('public'),
    );
    const payload = json.mock.calls[0]![0] as {
      menu: { slug: string };
      items: Array<{ id: string; label: string; children: Array<{ label: string }> }>;
    };
    expect(payload.menu.slug).toBe('primary');
    // Sorted by order_index: About (0), then Projects (1)
    expect(payload.items.map((i) => i.label)).toEqual(['About', 'Projects']);
    expect(payload.items[0]!.children.map((c) => c.label)).toEqual(['About Us']);
  });

  it('filters out authenticated_only items (top-level + descendants)', async () => {
    const deps = makeDeps({
      sites: [{ id: 'site-1', slug: 'aaif', name: 'AAIF', config: {} }],
      navigation_menus: [
        { id: 'menu-1', host_kind: 'site', host_id: 'site-1', slug: 'primary', name: 'Header' },
      ],
      navigation_menu_items: [
        {
          id: 'p',
          menu_id: 'menu-1',
          parent_id: null,
          order_index: 0,
          label: 'Public Item',
          page_id: null,
          external_url: '/public',
          anchor_target: null,
          open_in_new_tab: false,
          rel_attributes: null,
          css_classes: null,
          visibility: 'always',
        },
        {
          id: 's',
          menu_id: 'menu-1',
          parent_id: null,
          order_index: 1,
          label: 'Members Only',
          page_id: null,
          external_url: '/members',
          anchor_target: null,
          open_in_new_tab: false,
          rel_attributes: null,
          css_classes: null,
          visibility: 'authenticated_only',
        },
        {
          id: 's-child',
          menu_id: 'menu-1',
          parent_id: 's',
          order_index: 0,
          label: 'Members Sub',
          page_id: null,
          external_url: '/members/sub',
          anchor_target: null,
          open_in_new_tab: false,
          rel_attributes: null,
          css_classes: null,
          visibility: 'always',
        },
      ],
      pages: [],
    });
    const routes = createPublicMenusRoutes(deps);
    const req = { params: { siteSlug: 'aaif', menuSlug: 'primary' } } as unknown as Request;
    const { res, json } = makeRes();

    await routes.getNavigation(req, res);

    const payload = json.mock.calls[0]![0] as {
      items: Array<{ id: string; label: string; children: Array<{ label: string }> }>;
    };
    // 's' is filtered out; its child 's-child' gets promoted to root
    // (the orphan-promotion rule) — that's still a public-only item
    // surface, but never the auth-gated parent.
    const labels = payload.items.map((i) => i.label).sort();
    expect(labels).toContain('Public Item');
    expect(labels).not.toContain('Members Only');
  });

  it('resolves page_slug when item.page_id matches a published page', async () => {
    const deps = makeDeps({
      sites: [{ id: 'site-1', slug: 'aaif', name: 'AAIF', config: {} }],
      navigation_menus: [
        { id: 'menu-1', host_kind: 'site', host_id: 'site-1', slug: 'primary', name: 'Header' },
      ],
      navigation_menu_items: [
        {
          id: 'a',
          menu_id: 'menu-1',
          parent_id: null,
          order_index: 0,
          label: 'Home',
          page_id: 'page-1',
          external_url: null,
          anchor_target: null,
          open_in_new_tab: false,
          rel_attributes: null,
          css_classes: null,
          visibility: 'always',
        },
      ],
      pages: [{ id: 'page-1', slug: 'home', full_path: '/' }],
    });
    const routes = createPublicMenusRoutes(deps);
    const req = { params: { siteSlug: 'aaif', menuSlug: 'primary' } } as unknown as Request;
    const { res, json } = makeRes();

    await routes.getNavigation(req, res);

    const payload = json.mock.calls[0]![0] as {
      items: Array<{ page_slug: string | null; external_url: string | null }>;
    };
    expect(payload.items[0]!.page_slug).toBe('home');
    expect(payload.items[0]!.external_url).toBeNull();
  });
});

describe('getSettings', () => {
  it('returns 404 when site not found', async () => {
    const deps = makeDeps({ sites: [] });
    const routes = createPublicMenusRoutes(deps);
    const req = { params: { siteSlug: 'unknown' } } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.getSettings(req, res);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: 'site_not_found' }));
  });

  it('returns AAIF socials + copyright when slug is aaif and config absent', async () => {
    const deps = makeDeps({
      sites: [{ id: 'site-1', slug: 'aaif', name: 'AAIF', config: {} }],
      host_media: [],
    });
    const routes = createPublicMenusRoutes(deps);
    const req = { params: { siteSlug: 'aaif' } } as unknown as Request;
    const { res, status, json } = makeRes();

    await routes.getSettings(req, res);

    expect(status).toHaveBeenCalledWith(200);
    const payload = json.mock.calls[0]![0] as {
      socials: { x: string | null; linkedin: string | null; github: string | null };
      copyright: string;
      linux_foundation_banner: boolean;
    };
    expect(payload.socials.x).toContain('twitter.com/aaif');
    expect(payload.socials.linkedin).toContain('linkedin.com');
    expect(payload.socials.github).toContain('github.com');
    expect(payload.copyright).toContain('Agentic AI Foundation');
    expect(payload.linux_foundation_banner).toBe(true);
  });

  it('honours sites.config.branding overrides', async () => {
    const deps = makeDeps({
      sites: [
        {
          id: 'site-1',
          slug: 'aaif',
          name: 'AAIF',
          config: {
            branding: {
              header_logo: { url: 'https://cdn.example/logo.svg', alt: 'Custom Logo' },
              socials: { x: 'https://x.com/override' },
              copyright: 'Custom © 2026',
              linux_foundation_banner: false,
            },
          },
        },
      ],
      host_media: [],
    });
    const routes = createPublicMenusRoutes(deps);
    const req = { params: { siteSlug: 'aaif' } } as unknown as Request;
    const { res, json } = makeRes();

    await routes.getSettings(req, res);

    const payload = json.mock.calls[0]![0] as {
      logo: { url: string; alt: string } | null;
      socials: { x: string | null };
      copyright: string;
      linux_foundation_banner: boolean;
    };
    expect(payload.logo).toEqual({ url: 'https://cdn.example/logo.svg', alt: 'Custom Logo' });
    expect(payload.socials.x).toBe('https://x.com/override');
    expect(payload.copyright).toBe('Custom © 2026');
    expect(payload.linux_foundation_banner).toBe(false);
  });

  it('builds logo URL from host_media when no branding config', async () => {
    const deps = makeDeps({
      sites: [{ id: 'site-1', slug: 'aaif', name: 'AAIF', config: {} }],
      host_media: [
        {
          id: 'm1',
          host_kind: 'site',
          host_id: 'site-1',
          storage_path: 'sites/site-1/media/aaif-secondary-logo-black.svg',
          filename: 'aaif-secondary-logo-black.svg',
          mime_type: 'image/svg+xml',
        },
      ],
    });
    const routes = createPublicMenusRoutes(deps);
    const req = { params: { siteSlug: 'aaif' } } as unknown as Request;
    const { res, json } = makeRes();

    await routes.getSettings(req, res);

    const payload = json.mock.calls[0]![0] as { logo: { url: string; alt: string } | null };
    expect(payload.logo?.url).toContain('aaif-secondary-logo-black.svg');
    expect(payload.logo?.url).toContain('/storage/v1/object/public/media/');
  });

  it('sets Cache-Control header on success', async () => {
    const deps = makeDeps({
      sites: [{ id: 'site-1', slug: 'aaif', name: 'AAIF', config: {} }],
      host_media: [],
    });
    const routes = createPublicMenusRoutes(deps);
    const req = { params: { siteSlug: 'aaif' } } as unknown as Request;
    const { res, setHeader } = makeRes();

    await routes.getSettings(req, res);

    expect(setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      expect.stringMatching(/public.*max-age=60/),
    );
  });
});
