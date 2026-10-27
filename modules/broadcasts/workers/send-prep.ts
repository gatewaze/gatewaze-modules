/**
 * Prepare one due scheduled send: refresh its segment, fan out recipients,
 * and decide whether it starts, waits for the next tick, or fails.
 *
 * Kept free of I/O so the decisions are testable; the dispatcher supplies an
 * AudienceDb backed by a direct Postgres connection (no PostgREST 8s limit)
 * or by PostgREST.
 */

// If the segment was recalculated within this window, skip the recalc before
// fan-out (avoids a redundant full recompute on every send).
export const SEGMENT_FRESHNESS_MS = 60 * 60 * 1000

// A failed refresh is retried on later ticks for this long after the scheduled
// time. After that the send goes to the stored audience and says so in its
// metadata, rather than not going at all.
export const REFRESH_RETRY_WINDOW_MS = 10 * 60 * 1000

export const EMPTY_AUDIENCE_REASON = '0 deliverable recipients after suppression filtering'

export interface DueSend {
  id: string
  metadata: Record<string, unknown> | null
  audience_type?: string | null
  segment_id?: string | null
  scheduled_at?: string | null
}

export interface AudienceDb {
  segmentCalculatedAt(segmentId: string): Promise<string | null>
  /** Recalculate the segment atomically; throws on failure. */
  recalculate(segmentId: string): Promise<void>
  /** Populate broadcast_send_recipients; throws on failure. */
  fanout(sendId: string): Promise<void>
  countRecipients(sendId: string): Promise<number>
}

export type SendPrep =
  | { action: 'start'; metadata: Record<string, unknown> }
  | { action: 'retry'; metadata: Record<string, unknown>; reason: string }
  | { action: 'fail'; metadata: Record<string, unknown>; reason: string }

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function prepareSend(send: DueSend, db: AudienceDb, now: number = Date.now()): Promise<SendPrep> {
  const metadata: Record<string, unknown> = { ...(send.metadata ?? {}) }
  const at = new Date(now).toISOString()

  if (send.audience_type === 'segment' && send.segment_id) {
    let last: string | null = null
    try {
      last = await db.segmentCalculatedAt(send.segment_id)
    } catch {
      last = null
    }
    if (last && now - new Date(last).getTime() < SEGMENT_FRESHNESS_MS) {
      metadata.audience_refresh = { status: 'skipped', calculated_at: last, at }
    } else {
      try {
        await db.recalculate(send.segment_id)
        metadata.audience_refresh = { status: 'refreshed', at }
      } catch (err) {
        const prev = (send.metadata?.audience_refresh ?? {}) as { attempts?: number }
        const attempts = (prev.attempts ?? 0) + 1
        const error = message(err)
        const scheduled = send.scheduled_at ? new Date(send.scheduled_at).getTime() : now
        if (now - scheduled < REFRESH_RETRY_WINDOW_MS) {
          metadata.audience_refresh = { status: 'retrying', error, attempts, at }
          return { action: 'retry', metadata, reason: `audience refresh failed: ${error}` }
        }
        metadata.audience_refresh = { status: 'failed', error, attempts, at, used_audience_calculated_at: last }
      }
    }
  }

  try {
    await db.fanout(send.id)
  } catch (err) {
    const reason = `Fan-out failed: ${message(err)}`
    return { action: 'fail', metadata: { ...metadata, error: reason }, reason }
  }

  const count = await db.countRecipients(send.id)
  if (count === 0) {
    return { action: 'fail', metadata: { ...metadata, error: EMPTY_AUDIENCE_REASON }, reason: EMPTY_AUDIENCE_REASON }
  }
  return { action: 'start', metadata }
}
