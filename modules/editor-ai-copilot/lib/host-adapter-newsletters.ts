/**
 * Newsletters HostAdapter — resolves a (collectionId, editionId) into the
 * PuckData + libraryId + themeKind=email shape the AI generator needs.
 *
 * Schema reference (per newsletters/admin/pages/editions/[id].tsx and
 * newsletters/public-api.ts):
 *
 *   - `newsletters_template_collections` is the collection / library row.
 *     Its `id` is also the `library_id` that `templates_block_defs.library_id`
 *     points at, so the collection IS the library for our purposes.
 *   - `newsletters_editions` rows:
 *       id, collection_id, title, preheader, status, edition_date, ...
 *   - `newsletters_edition_blocks` rows (one row per block on an edition):
 *       id, edition_id, templates_block_def_id (nullable for registry
 *       blocks), block_type, content (jsonb), sort_order.
 *
 * Caller-supplied host identity (from the editor's
 * `CanvasPluginHostContext`):
 *   - `hostKind = 'newsletter'`
 *   - `hostId   = edition.collection_id ?? edition.id` (fallback when the
 *     edition isn't bound to a collection — historically rare).
 *   - `targetId = edition.id`
 */

import type { HostAdapter, HostLoadResult } from './types.js';

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

interface EditionRow {
  id: string;
  collection_id: string | null;
  title: string | null;
  preheader: string | null;
}

interface BlockRow {
  id: string;
  block_type: string;
  content: Record<string, unknown> | null;
  sort_order: number;
}

export function createNewslettersHostAdapter(deps: { supabase: SupabaseLike }): HostAdapter {
  return {
    async loadTarget({ hostId, targetId }): Promise<HostLoadResult> {
      // Edition row. We don't filter by `collection_id == hostId` because
      // the editor uses `collectionId ?? edition.id` as hostId — when no
      // collection is set (legacy editions), hostId equals targetId and
      // the strict filter would mis-reject. We instead verify the
      // collection_id matches OR the edition has none below.
      const editionRes = await deps.supabase
        .from('newsletters_editions')
        .select('id, collection_id, title, preheader')
        .eq('id', targetId)
        .maybeSingle();

      const edition = editionRes?.data as EditionRow | null;
      if (!edition) {
        throw new Error('newsletter_edition_not_found');
      }

      // Authorize: the hostId from the editor must match either the
      // edition's collection_id (the normal case) or the edition's own
      // id (legacy editions with no collection — the editor fell back
      // to edition.id as the hostId).
      const validHost = edition.collection_id === hostId || edition.id === hostId;
      if (!validHost) {
        throw new Error('newsletter_edition_not_found');
      }

      // Resolve the library — for newsletters the collection IS the
      // library (its id is the value `templates_block_defs.library_id`
      // points at). If no collection is set we can't generate, since
      // there's no template surface to constrain the AI against.
      const libraryId = edition.collection_id;
      if (!libraryId) {
        throw new Error('newsletter_has_no_library');
      }

      // Blocks. We don't need bricks at this layer — the AI is
      // constrained to top-level blocks; brick-level edits happen via
      // the `edit-block` mode on a selected brick id, and that lookup
      // walks the in-memory Puck tree (block.props.children) rather
      // than going back to the DB.
      const blocksRes = await deps.supabase
        .from('newsletters_edition_blocks')
        .select('id, block_type, content, sort_order')
        .eq('edition_id', edition.id)
        .order('sort_order', { ascending: true });

      const blockRows = ((blocksRes?.data as BlockRow[] | null) ?? []);
      const content = blockRows.map((b) => ({
        type: b.block_type,
        props: { id: b.id, ...(b.content ?? {}) },
      }));

      return {
        data: {
          content,
          root: {
            props: {
              subject: edition.title ?? '',
              preheader: edition.preheader ?? '',
            },
          },
        },
        themeKind: 'email',
        libraryId,
        pageTitle: edition.title ?? '',
      };
    },
  };
}
