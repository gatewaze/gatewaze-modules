/**
 * Scheduled-blast dispatcher — picks up `calendars_blasts` rows whose
 * `scheduled_at` has passed and routes them to the per-channel sender.
 *
 * Per spec-calendars-microsites §9.3 (Schedule button) + §8.4 (worker
 * routes calendar source through email-batch-send) + §8.5 (sms/whatsapp).
 *
 * Why this lives separate from CalendarBlastService.sendBlast():
 *   - sendBlast runs in the BROWSER under the user's auth — it's the
 *     immediate "Send now" path. Scheduled sends fire from the server-
 *     side cron worker (no user session) so they need the service-role
 *     client and a different concurrency story.
 *   - The CAS update (status='scheduled' → 'sending') is the dispatcher's
 *     idempotency guard: two cron ticks racing on the same row see the
 *     UPDATE return zero rows for the loser; the winner proceeds.
 *
 * Pure function — DB + dispatch are passed in so the unit tests can
 * exercise every branch without spinning up Supabase or BullMQ.
 */

export interface ScheduledBlastRow {
  id: string;
  calendar_id: string;
  channel: 'email' | 'sms' | 'whatsapp';
}

export interface DispatcherSupabaseClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

export interface ChannelDispatcher {
  /**
   * Fire the channel-specific send. Returns ok=true when the underlying
   * delivery worker accepted the request (the actual send is async); ok=false
   * with reason when accept failed (network, missing module, etc.).
   */
  dispatch(args: { blastId: string; calendarId: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface DispatcherDeps {
  supabase: DispatcherSupabaseClient;
  /** One dispatcher per channel; missing channels mark blasts as failed
   *  with reason "channel_module_not_installed". */
  channels: Partial<Record<ScheduledBlastRow['channel'], ChannelDispatcher>>;
  /** Max blasts to dispatch per tick. Default 25. */
  batchSize?: number;
  /** Override "now" for tests. */
  now?: () => Date;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface DispatcherResult {
  picked: number;
  dispatched: number;
  failed: number;
  perBlast: Array<{ id: string; status: 'dispatched' | 'failed'; reason?: string }>;
}

const noopLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export async function dispatchScheduledBlasts(deps: DispatcherDeps): Promise<DispatcherResult> {
  const log = deps.logger ?? noopLogger;
  const now = (deps.now ?? (() => new Date()))();
  const batchSize = deps.batchSize ?? 25;

  const result: DispatcherResult = { picked: 0, dispatched: 0, failed: 0, perBlast: [] };

  // 1. Pick up due rows. We don't FOR UPDATE SKIP LOCKED here — the CAS
  //    update below is the actual contention guard, and it works against a
  //    PostgREST query without needing a transaction.
  const due = await deps.supabase
    .from('calendars_blasts')
    .select('id, calendar_id, channel')
    .eq('status', 'scheduled')
    .lte('scheduled_at', now.toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(batchSize);

  if (due.error) {
    log.error('blast-dispatcher: failed to load due blasts', { error: due.error.message });
    return result;
  }

  const rows = (due.data ?? []) as ScheduledBlastRow[];
  result.picked = rows.length;

  for (const blast of rows) {
    // 2. CAS claim — only one worker may flip scheduled → sending.
    //    PostgREST's .update().eq().eq().select() returns the row(s) that
    //    actually changed; an empty array means another worker beat us
    //    (or the admin cancelled the blast in the gap between SELECT + UPDATE).
    const claim = await deps.supabase
      .from('calendars_blasts')
      .update({ status: 'sending', sent_at: now.toISOString() })
      .eq('id', blast.id)
      .eq('status', 'scheduled')
      .select('id');

    const claimed = Array.isArray(claim.data) && claim.data.length > 0;
    if (!claimed) {
      log.info('blast-dispatcher: skipped (already claimed)', { blastId: blast.id });
      continue;
    }

    // 3. Channel dispatch. A missing dispatcher means the channel module
    //    isn't installed; mark the blast failed so the admin sees it in
    //    history rather than silently spinning forever.
    const channel = deps.channels[blast.channel];
    if (!channel) {
      log.warn('blast-dispatcher: channel module not installed', {
        blastId: blast.id,
        channel: blast.channel,
      });
      await deps.supabase
        .from('calendars_blasts')
        .update({ status: 'failed' })
        .eq('id', blast.id);
      result.failed++;
      result.perBlast.push({ id: blast.id, status: 'failed', reason: 'channel_module_not_installed' });
      continue;
    }

    try {
      const dispatch = await channel.dispatch({ blastId: blast.id, calendarId: blast.calendar_id });
      if (!dispatch.ok) {
        await deps.supabase
          .from('calendars_blasts')
          .update({ status: 'failed' })
          .eq('id', blast.id);
        result.failed++;
        result.perBlast.push({ id: blast.id, status: 'failed', reason: dispatch.reason });
        log.warn('blast-dispatcher: dispatch failed', { blastId: blast.id, reason: dispatch.reason });
        continue;
      }
      // Note: status stays 'sending' — the channel's own delivery worker
      // (email-batch-send etc.) flips it to 'sent' or 'failed' when it
      // finishes. Mirrors the existing immediate-send flow.
      result.dispatched++;
      result.perBlast.push({ id: blast.id, status: 'dispatched' });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await deps.supabase
        .from('calendars_blasts')
        .update({ status: 'failed' })
        .eq('id', blast.id);
      result.failed++;
      result.perBlast.push({ id: blast.id, status: 'failed', reason });
      log.error('blast-dispatcher: dispatch threw', { blastId: blast.id, error: reason });
    }
  }

  log.info('blast-dispatcher: tick complete', {
    picked: result.picked,
    dispatched: result.dispatched,
    failed: result.failed,
  });

  return result;
}
