/**
 * SSR helpers exposed to wrappers + blocks.
 *
 * Per spec-content-modules-git-architecture §10.5 + §12.5:
 *
 *   useCurrentUser()          → User | null
 *   useUserRelation(entity, id) → RelationResult
 *   useUserRelations(entity, ids) → Map<id, RelationResult>
 *   useNavigationMenu(slug)   → MenuTree
 *   useSectionPages(prefix, opts?) → Page[]
 *   useSiteMeta()             → { name, description, tokens }
 *
 * These run at SSR time on the server side. The hook functions read from
 * the per-request context (set by the publisher's request middleware) and
 * call the appropriate platform service.
 */

import type { UserContext } from './user-relation.js';
import { resolveUserRelation, resolveUserRelations, type RelationResult } from './user-relation.js';

// ---------------------------------------------------------------------------
// Per-request context (set by the SSR runtime)
// ---------------------------------------------------------------------------

export interface SsrContext {
  user: UserContext | null;
  siteId: string;
  siteSlug: string;
  /** Site-level wrapper id resolved at request boundary. */
  wrapperId: string | null;
  /** Brand tokens from gatewaze.theme.json. */
  themeTokens: Record<string, unknown>;
  /** Helper for the menus/pages/media queries — narrow Supabase client. */
  supabase: SsrSupabaseClient;
}

/**
 * Why `any` on `from()`: the SSR helpers chain .select().eq().eq().eq()
 * .ilike().in().order().single() in shapes that can't be expressed in
 * a narrow interface without re-declaring the entire PostgrestQueryBuilder
 * type. Same justification as in API routes — the OSS modules don't ship
 * generated Database types. Per-callsite `as { ... } | null` casts handle
 * the result shape.
 */
export interface SsrSupabaseClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

let currentContext: SsrContext | null = null;

/**
 * Internal: called by the SSR runtime middleware at the start of each
 * request, and unset (with try/finally) at the end. Hooks read from this.
 */
export function _setSsrContext(ctx: SsrContext): void {
  currentContext = ctx;
}

export function _clearSsrContext(): void {
  currentContext = null;
}

function requireContext(hookName: string): SsrContext {
  if (!currentContext) {
    throw new Error(`${hookName}: called outside of an SSR context. Hooks must be invoked during a request.`);
  }
  return currentContext;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useCurrentUser(): UserContext | null {
  return requireContext('useCurrentUser').user;
}

export async function useUserRelation(entity: string, entityId: string): Promise<RelationResult> {
  const ctx = requireContext('useUserRelation');
  return resolveUserRelation(entity, entityId, ctx.user);
}

export async function useUserRelations(entity: string, entityIds: string[]): Promise<Map<string, RelationResult>> {
  const ctx = requireContext('useUserRelations');
  return resolveUserRelations(entity, entityIds, ctx.user);
}

export interface SiteMeta {
  id: string;
  slug: string;
  themeTokens: Record<string, unknown>;
}

export function useSiteMeta(): SiteMeta {
  const ctx = requireContext('useSiteMeta');
  return {
    id: ctx.siteId,
    slug: ctx.siteSlug,
    themeTokens: ctx.themeTokens,
  };
}

export interface MenuItem {
  id: string;
  label: string;
  url: string;
  openInNewTab: boolean;
  cssClasses: string | null;
  children: MenuItem[];
}

/**
 * Wrapper consumes a navigation menu by slug. Returns the flattened tree
 * with `page_id` resolved to `full_path`, `external_url` passed through,
 * `anchor_target` appended to current path. Visibility filtered for the
 * current viewer's auth state.
 */
export async function useNavigationMenu(menuSlug: string): Promise<MenuItem[]> {
  const ctx = requireContext('useNavigationMenu');
  const isAuthenticated = ctx.user !== null;

  // Fetch menu by slug for the current site
  const menuResult = await ctx.supabase
    .from('navigation_menus')
    .select('id')
    .eq('host_kind', 'site')
    .eq('host_id', ctx.siteId)
    .eq('slug', menuSlug)
    .single();
  const menu = (menuResult as { data: { id: string } | null }).data;
  if (!menu) return [];

  // Fetch all items for this menu (RLS filters by visibility for anon; we
  // post-filter for authenticated to handle the auth-only case).
  const itemsResult = await ctx.supabase
    .from('navigation_menu_items')
    .select('id, parent_id, order_index, label, page_id, external_url, anchor_target, open_in_new_tab, css_classes, visibility')
    .eq('menu_id', menu.id)
    .order('order_index', { ascending: true });
  const items = ((itemsResult as { data: NavigationMenuItemRow[] | null }).data ?? []);

  // Resolve page_id → full_path
  const pageIds = items.map((i) => i.page_id).filter((id): id is string => id !== null);
  const pageMap = new Map<string, string>();
  if (pageIds.length > 0) {
    const pagesResult = await ctx.supabase
      .from('pages').select('id, full_path').in('id', pageIds);
    const pages = ((pagesResult as { data: Array<{ id: string; full_path: string }> | null }).data ?? []);
    for (const p of pages) pageMap.set(p.id, p.full_path);
  }

  // Visibility filter
  const visible = items.filter((i) => {
    if (i.visibility === 'always') return true;
    if (i.visibility === 'authenticated_only') return isAuthenticated;
    if (i.visibility === 'public_only') return !isAuthenticated;
    return false;
  });

  // Build tree
  const byId = new Map<string, MenuItem & { _parentId: string | null; _order: number }>();
  for (const i of visible) {
    let url = '#';
    if (i.page_id) url = pageMap.get(i.page_id) ?? '#';
    else if (i.external_url) url = i.external_url;
    else if (i.anchor_target) url = i.anchor_target;
    byId.set(i.id, {
      id: i.id, label: i.label, url, openInNewTab: i.open_in_new_tab,
      cssClasses: i.css_classes, children: [],
      _parentId: i.parent_id, _order: i.order_index,
    });
  }
  const tree: MenuItem[] = [];
  for (const item of byId.values()) {
    if (item._parentId === null) {
      tree.push(item);
    } else {
      const parent = byId.get(item._parentId);
      if (parent) parent.children.push(item);
      else tree.push(item); // orphaned: surface at top level
    }
  }
  // Sort children by order at every level
  const sortRec = (nodes: MenuItem[]) => {
    nodes.sort((a, b) => (byId.get(a.id)?._order ?? 0) - (byId.get(b.id)?._order ?? 0));
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(tree);
  // Strip internal _parentId / _order before returning
  const strip = (n: MenuItem & { _parentId?: string | null; _order?: number }): MenuItem => ({
    id: n.id, label: n.label, url: n.url, openInNewTab: n.openInNewTab,
    cssClasses: n.cssClasses, children: n.children.map(strip),
  });
  return tree.map(strip);
}

interface NavigationMenuItemRow {
  id: string;
  parent_id: string | null;
  order_index: number;
  label: string;
  page_id: string | null;
  external_url: string | null;
  anchor_target: string | null;
  open_in_new_tab: boolean;
  css_classes: string | null;
  visibility: 'always' | 'authenticated_only' | 'public_only';
}

export interface SectionPage {
  id: string;
  full_path: string;
  title: string;
  section_order: number;
}

export interface UseSectionPagesOptions {
  sort?: 'section_order' | 'created_at';
}

export async function useSectionPages(
  prefix: string,
  opts?: UseSectionPagesOptions,
): Promise<SectionPage[]> {
  const ctx = requireContext('useSectionPages');
  const sortCol = opts?.sort === 'created_at' ? 'created_at' : 'section_order';

  // Use ilike for prefix match — RLS handles per-viewer page visibility.
  const result = await ctx.supabase
    .from('pages')
    .select('id, full_path, title, section_order')
    .eq('host_kind', 'site')
    .eq('host_id', ctx.siteId)
    .eq('status', 'published')
    .ilike('full_path', `${prefix}%`)
    .order(sortCol, { ascending: true });
  return ((result as { data: SectionPage[] | null }).data ?? []);
}
