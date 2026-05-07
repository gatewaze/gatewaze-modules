// @ts-nocheck — depends on @supabase/supabase-js which requires workspace install.

/**
 * YouTube reconcile cron — every 5 minutes, finds host_media rows with
 * youtube_upload_status IN ('pending','failed') AND
 * youtube_next_retry_at <= now() and triggers the
 * media-process-youtube-uploads edge fn for each. Idempotent — the
 * edge fn marks rows as 'completed' on success and bumps retry_count
 * + next_retry_at on failure.
 *
 * Per spec-host-media-module §12 (alert: failure rate > 20% over 1 h).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

interface Deps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>;
  logger: PlatformLogger;
}

const MAX_BATCH = 20;

export async function pollYoutubeUploads(deps: Deps): Promise<void> {
  const { data, error } = await deps.supabase
    .from('host_media')
    .select('id, host_kind, host_id, storage_path, filename, youtube_retry_count')
    .in('youtube_upload_status', ['pending', 'failed'])
    .lte('youtube_next_retry_at', new Date().toISOString())
    .limit(MAX_BATCH);

  if (error) {
    deps.logger.error('youtube-poll: select failed', { error: error.message });
    return;
  }
  if (!data || data.length === 0) {
    return;
  }

  deps.logger.info('youtube-poll: triggering edge fn', { count: data.length });

  // Trigger the edge fn for each pending row. The fn is idempotent and
  // updates the row in-place. Phase 2 wires this; Phase 1 just marks
  // the rows as 'processing' so the UI shows progress.
  const ids = data.map((r: { id: string }) => r.id);
  await deps.supabase
    .from('host_media')
    .update({
      youtube_upload_status: 'processing',
      youtube_processing_started_at: new Date().toISOString(),
    })
    .in('id', ids);

  // TODO Phase 2: invoke the media-upload-youtube edge fn here. For Phase 1,
  // the rows stay in 'processing' and an operator must transition them
  // manually or via the existing event-media YouTube path.
  deps.logger.warn('youtube-poll: edge fn invocation TODO (Phase 2)', {
    queued: ids.length,
  });
}

export default async function handler(payload: { data?: { kind?: string } }, deps: Deps): Promise<void> {
  if (payload.data?.kind !== 'host-media:youtube-poll') return;
  await pollYoutubeUploads(deps);
}
