/**
 * Sites HostAdapter — resolves a (siteId, pageId) into the PuckData
 * + library_id + themeKind that the AI generator needs.
 *
 * Stays inside the editor-ai-copilot module so we don't have to
 * export this interface from the sites module's public surface yet.
 * Phase 2 may move it into @gatewaze-modules/sites/host-adapter for
 * cleaner separation, but the polymorphic registry pattern works
 * either way.
 */

import type { HostAdapter, HostLoadResult } from './types.js';

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

export function createSitesHostAdapter(deps: { supabase: SupabaseLike }): HostAdapter {
  return {
    async loadTarget({ hostId, targetId }): Promise<HostLoadResult> {
      // Fetch the page + site row.
      const pageRes = await deps.supabase
        .from('pages')
        .select('id, host_kind, host_id, wrapper_id, content, title, full_path, composition_mode, templates_library_id')
        .eq('id', targetId)
        .eq('host_kind', 'site')
        .eq('host_id', hostId)
        .maybeSingle();
      const page = pageRes?.data as
        | {
            id: string;
            content: Record<string, unknown> | null;
            title: string;
            full_path: string;
            composition_mode: 'schema' | 'blocks';
            templates_library_id: string;
          }
        | null;
      if (!page) {
        throw new Error('site_page_not_found');
      }
      if (page.composition_mode !== 'blocks') {
        throw new Error('page_not_in_blocks_mode');
      }

      // Build PuckData from page_blocks rows.
      const blocksRes = await deps.supabase
        .from('page_blocks')
        .select('id, block_def_id, parent_brick_id, sort_order, content, variant_key, templates_block_defs!inner(key)')
        .eq('page_id', targetId)
        .is('parent_brick_id', null)
        .order('sort_order', { ascending: true });

      type BlockRow = {
        id: string;
        block_def_id: string;
        sort_order: number;
        content: Record<string, unknown>;
        variant_key: string;
        templates_block_defs: { key: string };
      };
      const blocks = ((blocksRes?.data as BlockRow[]) ?? []).map<{
        type: string;
        props: { id: string; [k: string]: unknown };
      }>((b) => ({
        type: b.templates_block_defs.key,
        props: { id: b.id, ...(b.content ?? {}) },
      }));

      return {
        data: { content: blocks, root: { props: (page.content as Record<string, unknown>) ?? {} } },
        themeKind: 'website',
        libraryId: page.templates_library_id,
        pageTitle: page.title,
        pagePath: page.full_path,
      };
    },
  };
}
