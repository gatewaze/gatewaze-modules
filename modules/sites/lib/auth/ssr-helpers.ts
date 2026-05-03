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

export interface SsrSupabaseClient {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): {
        order(col: string, opts?: { ascending: boolean }): {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          [key: string]: any;
        };
      };
      ilike(col: string, val: string): {
        order(col: string, opts?: { ascending: boolean }): {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          [key: string]: any;
        };
      };
    };
  };
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
  // Stub: full DB query would join navigation_menus → navigation_menu_items
  // → pages, filter by visibility, build tree. Implementation lives in the
  // SSR runtime in a follow-up commit (this is the public hook contract).
  void ctx;
  void menuSlug;
  return [];
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
  _opts?: UseSectionPagesOptions,
): Promise<SectionPage[]> {
  const ctx = requireContext('useSectionPages');
  // Stub: DB query for pages with full_path LIKE prefix%, ordered by
  // section_order then created_at. Implementation in SSR runtime.
  void ctx;
  void prefix;
  return [];
}
