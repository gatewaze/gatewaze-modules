/**
 * Delete a newsletter (template_collection) and all its dependencies.
 *
 * Cascades through:
 *   - newsletters_edition_links     (FK to edition_blocks)
 *   - newsletters_edition_bricks    (FK to edition_blocks ON DELETE CASCADE)
 *   - newsletters_edition_blocks    (FK to editions ON DELETE CASCADE)
 *   - newsletters_editions          (FK to collection — cascade if defined)
 *   - templates_brick_defs          (FK to block_defs)
 *   - templates_block_defs          (FK to library)
 *   - templates_libraries           (host_kind='newsletter', host_id=collection.id)
 *   - newsletters_template_collections (the row itself)
 *   - gatewaze_internal_repos       (host_kind='newsletter') — soft-delete
 *
 * The route runs as the admin's JWT (RLS-bound). Operations that need
 * to bypass RLS (e.g. cleaning up cross-table references) lean on the
 * api's service-role supabase client when available.
 *
 * Per spec-builder-evaluation §3.6 (extended). Mirrors sites' delete
 * pattern with the additional gitServer.softDeleteRepo step.
 */

import type { Response, NextFunction } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';

interface RequestWithUser {
  userId?: string;
  params: Record<string, string>;
  body: Record<string, unknown>;
}

interface MinimalGitServer {
  lookupRepo(hostKind: 'newsletter', hostId: string): Promise<{ id: string; barePath: string } | null>;
  softDeleteRepo?: (repo: { id: string; barePath: string }) => Promise<void>;
}

export interface DeleteCollectionDeps {
  supabase: SupabaseClient;
  gitServer?: MinimalGitServer;
}

export function createDeleteCollectionRoute(deps: DeleteCollectionDeps) {
  return async function deleteCollection(req: RequestWithUser, res: Response, _next: NextFunction): Promise<void> {
    if (!req.userId) {
      res.status(401).json({ error: { code: 'unauthenticated' } });
      return;
    }
    const collectionId = req.params.collectionId;
    if (!collectionId) {
      res.status(400).json({ error: { code: 'missing_collection_id' } });
      return;
    }
    const expectedName = typeof req.body.confirm_name === 'string' ? req.body.confirm_name : '';

    try {
      // 1. Confirm the collection exists + the supplied name matches.
      //    The name-match is the primary safety gate — the UI requires
      //    the operator to type it, so a mistyped click can't delete.
      const collRes = await deps.supabase
        .from('newsletters_template_collections')
        .select('id, name, slug')
        .eq('id', collectionId)
        .maybeSingle();
      if (collRes.error || !collRes.data) {
        res.status(404).json({ error: { code: 'collection_not_found' } });
        return;
      }
      const coll = collRes.data as { id: string; name: string; slug: string };
      if (!expectedName || expectedName.trim() !== coll.name) {
        res.status(400).json({
          error: {
            code: 'name_confirmation_mismatch',
            message: `Type the newsletter name "${coll.name}" exactly to confirm deletion.`,
          },
        });
        return;
      }

      // 2. Find all editions for this collection (used to scope the
      //    block / brick deletes — FK cascades may handle most of this
      //    on the right schema, but we delete explicitly to be safe
      //    on environments where the cascade chain isn't fully wired).
      const editionsRes = await deps.supabase
        .from('newsletters_editions')
        .select('id')
        .eq('collection_id', collectionId);
      const editionIds = (editionsRes.data ?? []).map((r) => (r as { id: string }).id);

      // 3. Cascade delete in dependency order.
      if (editionIds.length > 0) {
        // edition_links (FK to edition_blocks)
        const blocksOfEditions = await deps.supabase
          .from('newsletters_edition_blocks')
          .select('id')
          .in('edition_id', editionIds);
        const blockIds = (blocksOfEditions.data ?? []).map((r) => (r as { id: string }).id);
        if (blockIds.length > 0) {
          await deps.supabase.from('newsletters_edition_links').delete().in('block_id', blockIds);
        }
        // edition_blocks (cascades to bricks via FK)
        await deps.supabase.from('newsletters_edition_blocks').delete().in('edition_id', editionIds);
        // editions
        await deps.supabase.from('newsletters_editions').delete().in('id', editionIds);
      }

      // 4. Library + block/brick defs.
      const libIdsRes = await deps.supabase
        .from('templates_libraries')
        .select('id')
        .eq('host_kind', 'newsletter')
        .eq('host_id', collectionId);
      const libIds = (libIdsRes.data ?? []).map((r) => (r as { id: string }).id);
      if (libIds.length > 0) {
        const blockDefRes = await deps.supabase
          .from('templates_block_defs')
          .select('id')
          .in('library_id', libIds);
        const blockDefIds = (blockDefRes.data ?? []).map((r) => (r as { id: string }).id);
        if (blockDefIds.length > 0) {
          await deps.supabase.from('templates_brick_defs').delete().in('block_def_id', blockDefIds);
        }
        await deps.supabase.from('templates_block_defs').delete().in('library_id', libIds);
        await deps.supabase.from('templates_libraries').delete().in('id', libIds);
      }

      // 5. Internal git repo (soft-delete with 7-day grace per the
      //    sites' convention — actual purge is a sweeper). Failures
      //    are non-fatal: the repo cleanup can be retried separately.
      if (deps.gitServer) {
        try {
          const repo = await deps.gitServer.lookupRepo('newsletter', collectionId);
          if (repo && deps.gitServer.softDeleteRepo) {
            await deps.gitServer.softDeleteRepo(repo);
          }
        } catch (gitErr) {
          // eslint-disable-next-line no-console
          console.warn('[newsletters delete] internal repo soft-delete failed', gitErr);
        }
      }

      // 6. The collection row itself.
      const delRes = await deps.supabase
        .from('newsletters_template_collections')
        .delete()
        .eq('id', collectionId);
      if (delRes.error) {
        res.status(500).json({ error: { code: 'collection_delete_failed', message: delRes.error.message } });
        return;
      }

      res.status(200).json({
        kind: 'deleted',
        collectionId,
        name: coll.name,
        editionsRemoved: editionIds.length,
        librariesRemoved: libIds.length,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[newsletters delete-collection] error', err);
      res.status(500).json({
        error: { code: 'delete_failed', message: err instanceof Error ? err.message : String(err) },
      });
    }
  };
}
