// @ts-nocheck — depends on @supabase/supabase-js which requires workspace install.

/**
 * Hourly cleanup of expired chunked-upload sessions. Deletes the
 * tracking row + the orphan chunk objects in storage.
 *
 * Per spec-host-media-module §4.2.
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

const STORAGE_BUCKET = process.env.HOST_MEDIA_BUCKET ?? 'host-media';

export async function cleanupExpiredChunkedUploads(deps: Deps): Promise<void> {
  const { data: expired, error } = await deps.supabase
    .from('host_media_chunked_uploads')
    .select('id, host_kind, host_id, total_chunks')
    .in('status', ['pending', 'combining'])
    .lt('expires_at', new Date().toISOString());

  if (error) {
    deps.logger.error('chunked-cleanup: select failed', { error: error.message });
    return;
  }
  if (!expired || expired.length === 0) return;

  deps.logger.info('chunked-cleanup: reaping expired sessions', { count: expired.length });

  for (const session of expired as Array<{ id: string; host_kind: string; host_id: string; total_chunks: number }>) {
    // Build the chunk paths and delete them.
    const paths: string[] = [];
    for (let i = 0; i < session.total_chunks; i++) {
      paths.push(`${session.host_kind}/${session.host_id}/__chunked/${session.id}/${i}`);
    }
    try {
      await deps.supabase.storage.from(STORAGE_BUCKET).remove(paths);
    } catch (err) {
      deps.logger.warn('chunked-cleanup: storage remove failed', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await deps.supabase
      .from('host_media_chunked_uploads')
      .update({ status: 'expired' })
      .eq('id', session.id);
  }
}

export default async function handler(payload: { data?: { kind?: string } }, deps: Deps): Promise<void> {
  if (payload.data?.kind !== 'host-media:chunked-cleanup') return;
  await cleanupExpiredChunkedUploads(deps);
}
