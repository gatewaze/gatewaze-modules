/**
 * Newsletter editions — snapshot job.
 *
 * Runs as a cron worker. Per spec §15.4:
 *
 *   1. Find editions where snapshot_status = 'pending' AND
 *      sent_at < (now() - lists.snapshot_delay_days * interval '1 day')
 *
 *   2. Fetch final aggregate stats from ESP (or aggregate from
 *      newsletters_edition_events table if we keep one)
 *
 *   3. Write metadata.json update to publish branch (single deterministic
 *      commit per edition, status='closed')
 *
 *   4. Purge per-recipient HTML from DB (the per-recipient personalized
 *      HTML kept for the snapshot_delay_days window for in-window resends)
 *
 *   5. Set snapshot_status='snapshotted', snapshot_at=now()
 */

import { buildSnapshotPublishFiles, type SnapshotPayload } from './edition-writer.js';

export interface SnapshotJobDeps {
  supabase: {
    rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
    from(table: string): {
      select(cols: string): {
        eq(col: string, val: unknown): {
          // narrow surface for the snapshot fetch
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          [key: string]: any;
        };
      };
      update(values: Record<string, unknown>): {
        eq(col: string, val: unknown): Promise<{ error: { message: string } | null }>;
      };
      delete(): {
        eq(col: string, val: unknown): Promise<{ error: { message: string } | null }>;
      };
    };
  };
  esp: {
    /**
     * Fetch final aggregate stats for a sent edition. Returns null if the
     * ESP doesn't have data yet (job will retry next tick).
     */
    fetchEditionStats(editionId: string): Promise<SnapshotPayload['finalStats'] | null>;
  };
  publishWorker: {
    /**
     * Enqueue a publish-branch commit for a list. The worker handles the
     * advisory lock and per-list publish flow.
     */
    enqueueListPublish(args: {
      listId: string;
      files: Map<string, Buffer | string>;
      message: string;
      tag?: string;
    }): Promise<{ commitSha: string; tag?: string }>;
  };
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

interface DueEdition {
  id: string;
  list_id: string;
  list_slug: string;
  list_snapshot_delay_days: number;
  subject: string;
  sender: string;
  sent_at: string;
  template_sha: string;
  send_count: number;
}

export async function runSnapshotJob(deps: SnapshotJobDeps): Promise<{ snapshotted: number; skipped: number; failed: number }> {
  const { supabase, esp, publishWorker, logger } = deps;
  let snapshotted = 0;
  let skipped = 0;
  let failed = 0;

  // Fetch via RPC: find editions due for snapshotting (joins lists for snapshot_delay_days)
  const { data: dueRaw, error: fetchErr } = await supabase.rpc('newsletters_find_due_snapshots', {});
  if (fetchErr) {
    logger.error('snapshot job: fetch failed', { error: fetchErr.message });
    throw new Error(`snapshot job fetch failed: ${fetchErr.message}`);
  }
  const due = (Array.isArray(dueRaw) ? dueRaw : []) as DueEdition[];

  for (const edition of due) {
    try {
      const finalStats = await esp.fetchEditionStats(edition.id);
      if (!finalStats) {
        logger.info('snapshot job: ESP stats not yet available; skip', { editionId: edition.id });
        skipped++;
        continue;
      }

      const snapshotAt = new Date().toISOString();
      const publishFiles = buildSnapshotPublishFiles(
        { editionId: edition.id, finalStats, snapshotAt },
        {
          sentAt: edition.sent_at,
          listSlug: edition.list_slug,
          subject: edition.subject,
          sender: edition.sender,
          templateSha: edition.template_sha,
          sendCount: edition.send_count,
        },
      );

      const { commitSha } = await publishWorker.enqueueListPublish({
        listId: edition.list_id,
        files: publishFiles.files,
        message: publishFiles.message,
      });

      // Mark edition as snapshotted
      const { error: updErr } = await supabase
        .from('newsletters_editions')
        .update({
          snapshot_status: 'snapshotted',
          snapshot_at: snapshotAt,
          publish_commit_sha: commitSha,
        })
        .eq('id', edition.id);
      if (updErr) {
        logger.error('snapshot job: update failed', { editionId: edition.id, error: updErr.message });
        failed++;
        continue;
      }

      // Purge per-recipient personalized HTML (PII boundary, per spec §15.3)
      const { error: purgeErr } = await supabase
        .from('newsletters_edition_recipient_renders')
        .delete()
        .eq('edition_id', edition.id);
      if (purgeErr) {
        // Log but don't fail the whole snapshot — the metadata write succeeded
        logger.warn('snapshot job: per-recipient HTML purge failed', { editionId: edition.id, error: purgeErr.message });
      }

      logger.info('snapshot job: edition snapshotted', { editionId: edition.id, commitSha });
      snapshotted++;
    } catch (err) {
      logger.error('snapshot job: edition failed', {
        editionId: edition.id,
        error: err instanceof Error ? err.message : String(err),
      });
      failed++;
    }
  }

  return { snapshotted, skipped, failed };
}
