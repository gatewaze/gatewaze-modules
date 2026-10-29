import type { Job } from 'bullmq'
// Static (not dynamic) import: a bare-specifier `await import('@supabase/...')`
// from this module-file location does not resolve in the worker runtime; a
// top-level import does (matches newsletters/workers/dispatch-scheduled).
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import pg from 'pg'
import { prepareSend, type AudienceDb, type DueSend } from './send-prep.js'

const supabaseUrl = process.env.SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

interface DispatchJobData {
  kind: string
}

// PostgREST runs every call under an 8s statement_timeout. A 5,000-row page
// keeps each fan-out call under it for typical audiences.
const BROADCAST_FANOUT_BATCH = Number(process.env.BROADCAST_FANOUT_BATCH ?? 5000)
// Over the direct connection there is no 8s limit: refreshing a segment takes
// up to ~20s and one fan-out page of a 30k audience ~10s on AAIF, both of which
// failed via PostgREST (sends marked failed; audiences sent stale).
const DIRECT_STATEMENT_TIMEOUT = '300s'
const DIRECT_FANOUT_BATCH = 20000 // the batch function's own ceiling

async function fanoutPages(
  call: (after: string | null) => Promise<{ last_email: string | null; remaining: boolean } | null>,
): Promise<void> {
  let after: string | null = null
  let guard = 0
  for (;;) {
    const row = await call(after)
    if (!row) break
    after = row.last_email ?? after
    if (!row.remaining) break
    if (++guard > 10_000) throw new Error('fanout batch guard tripped')
  }
}

/** Shared reads that are fast enough for PostgREST on either path. */
function supabaseReads(supabase: SupabaseClient): Pick<AudienceDb, 'segmentCalculatedAt' | 'countRecipients'> {
  return {
    async segmentCalculatedAt(segmentId) {
      const { data } = await supabase.from('segments').select('last_calculated_at').eq('id', segmentId).maybeSingle()
      return (data as { last_calculated_at?: string | null } | null)?.last_calculated_at ?? null
    },
    async countRecipients(sendId) {
      const { count, error } = await supabase
        .from('broadcast_send_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('send_id', sendId)
      if (error) throw new Error(`count recipients: ${error.message}`)
      return count ?? 0
    },
  }
}

function postgrestDb(supabase: SupabaseClient): AudienceDb {
  return {
    ...supabaseReads(supabase),
    async recalculate(segmentId) {
      const { error } = await supabase.rpc('segments_calculate_members', { p_segment_id: segmentId })
      if (error) throw new Error(error.message)
    },
    async fanout(sendId) {
      await fanoutPages(async (after) => {
        const { data, error } = await supabase.rpc('fanout_broadcast_send_recipients_batch', {
          p_send_id: sendId,
          p_batch_size: BROADCAST_FANOUT_BATCH,
          p_after_email: after,
        })
        if (error) throw new Error(error.message)
        return (Array.isArray(data) ? data[0] : data) ?? null
      })
    },
  }
}

/** Run one statement in its own transaction with the long timeout. Works
 *  behind a transaction-mode pooler too, since nothing relies on session state. */
async function inTx<T>(c: pg.Client, fn: () => Promise<T>, claims?: string): Promise<T> {
  await c.query('BEGIN')
  try {
    await c.query(`SET LOCAL statement_timeout = '${DIRECT_STATEMENT_TIMEOUT}'`)
    // segments_calculate_members admits the service role via auth.role(),
    // which reads these claims — the same ones PostgREST sets for a
    // service-key request.
    if (claims) await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims])
    const out = await fn()
    await c.query('COMMIT')
    return out
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined)
    throw err
  }
}

function directDb(c: pg.Client, supabase: SupabaseClient): AudienceDb {
  return {
    ...supabaseReads(supabase),
    async recalculate(segmentId) {
      await inTx(c, () => c.query('SELECT public.segments_calculate_members($1)', [segmentId]), '{"role":"service_role"}')
    },
    async fanout(sendId) {
      await fanoutPages(async (after) => {
        const { rows } = await inTx(c, () =>
          c.query('SELECT last_email, remaining FROM public.fanout_broadcast_send_recipients_batch($1, $2, $3)', [
            sendId,
            DIRECT_FANOUT_BATCH,
            after,
          ]),
        )
        return rows[0] ?? null
      })
    },
  }
}

async function openDirect(): Promise<pg.Client | null> {
  const url = process.env.DATABASE_URL
  if (!url) return null
  const c = new pg.Client({ connectionString: url, application_name: 'broadcasts-dispatch' })
  // A dropped connection emits 'error'; unhandled, it would crash the worker.
  c.on('error', (e) => console.warn(`[broadcast:dispatch-scheduled] direct connection error: ${e.message}`))
  try {
    await c.connect()
    return c
  } catch (err) {
    console.warn('[broadcast:dispatch-scheduled] direct connection unavailable, using PostgREST:', err instanceof Error ? err.message : err)
    await c.end().catch(() => undefined)
    return null
  }
}

/**
 * Heartbeat that fires due scheduled broadcast sends + drives the per-recipient
 * drip. Mirrors newsletters:dispatch-scheduled exactly.
 *
 * Scheduling is DB-as-source-of-truth: a broadcast_sends row with
 * `status='scheduled'` and a `scheduled_at`. This 60s BullMQ cron is the
 * pg_cron stand-in that works on every deploy target (Docker, k8s, cloud +
 * self-hosted Supabase) without relying on pg_cron / pg_net.
 *
 * Per-tick sequence (in order):
 *   1. Select due `status='scheduled'` rows.
 *   2. For each (see send-prep.ts): recalculate the segment unless it is
 *      under an hour old, call `fanout_broadcast_send_recipients_batch` to
 *      populate the per-recipient timing queue, check for an empty audience
 *      after suppression, then flip to 'sending' or 'failed' with the reason
 *      in metadata.error. A failed refresh is retried for 10 minutes, then
 *      the send goes to the stored audience with metadata.audience_refresh
 *      recording why. Both steps use DATABASE_URL when set (no 8s limit).
 *   3. Run a drip tick over the shared high-throughput send engine.
 *
 * Overlapping ticks are safe — the status flip plus the `FOR UPDATE SKIP
 * LOCKED` recipient claim guard against double-sends.
 *
 * The broadcast-send Edge function still exists but only handles single-
 * recipient test sends (processTestSend / processTestSendFromParent) — the
 * scheduled-dispatch path no longer round-trips through it.
 */
export default async function handleDispatchScheduled(_job: Job<DispatchJobData>) {
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // 1. Find due scheduled broadcasts.
  let processed = 0
  const errors: string[] = []
  const { data: due, error: selectErr } = await supabase
    .from('broadcast_sends')
    .select('id, metadata, audience_type, segment_id, scheduled_at')
    .eq('status', 'scheduled')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at')
    .limit(10)

  if (selectErr) {
    throw new Error(`[broadcast:dispatch-scheduled] select due sends failed: ${selectErr.message}`)
  }

  // 2. Refresh the audience, fan out, and flip status for each due send.
  // Every status write is conditional on status still being 'scheduled', so a
  // send cancelled mid-refresh stays cancelled and an overlapping tick that
  // already started it is not overwritten. Fan-out is idempotent (ON CONFLICT).
  const direct = due?.length ? await openDirect() : null
  const db = direct ? directDb(direct, supabase) : postgrestDb(supabase)
  try {
    for (const send of (due ?? []) as DueSend[]) {
      try {
        const prep = await prepareSend(send, db)
        const now = new Date().toISOString()
        const patch =
          prep.action === 'start'
            ? { status: 'sending', started_at: now, metadata: prep.metadata, updated_at: now }
            : prep.action === 'fail'
              ? { status: 'failed', completed_at: now, metadata: prep.metadata, updated_at: now }
              : { metadata: prep.metadata, updated_at: now }
        if (prep.action !== 'start') {
          const msg = `Broadcast ${send.id}: ${prep.reason}${prep.action === 'retry' ? ' (will retry)' : ''}`
          console.error('[broadcast:dispatch-scheduled]', msg)
          errors.push(msg)
        } else {
          const refresh = prep.metadata.audience_refresh as { status?: string; error?: string } | undefined
          if (refresh?.status === 'failed') {
            console.error(`[broadcast:dispatch-scheduled] Broadcast ${send.id}: sending to stored audience, refresh failed: ${refresh.error}`)
          }
        }
        const { error: writeErr } = await supabase
          .from('broadcast_sends')
          .update(patch)
          .eq('id', send.id)
          .eq('status', 'scheduled')
        if (writeErr) {
          const msg = `Broadcast ${send.id} status write: ${writeErr.message}`
          console.error('[broadcast:dispatch-scheduled]', msg)
          errors.push(msg)
          continue
        }
        if (prep.action === 'start') processed++
      } catch (err) {
        const msg = `Broadcast ${send.id}: ${err instanceof Error ? err.message : 'unknown error'}`
        console.error('[broadcast:dispatch-scheduled] unexpected:', msg)
        errors.push(msg)
      }
    }
  } finally {
    await direct?.end().catch(() => undefined)
  }

  if (processed) {
    console.log(`[broadcast:dispatch-scheduled] dispatched ${processed} due broadcast(s)`)
  }
  if (errors.length) {
    console.error('[broadcast:dispatch-scheduled] send errors:', errors)
  }

  // 3. Per-recipient drip via the shared Central Sending Service engine.
  let engine: { claimed: number; sent: number; failed: number } | null = null
  try {
    const [engMod, bindMod] = await Promise.all([
      import('../../bulk-emailing/worker/send-engine/engine.js'),
      import('./send-engine-binding.js'),
    ])
    // Interop-safe: these modules have no package.json "type":"module", so
    // under tsx/CJS `await import()` nests exports under .default.
    const runDripTick = (engMod as { runDripTick?: typeof import('../../bulk-emailing/worker/send-engine/engine.js').runDripTick }).runDripTick
      ?? (engMod as { default?: { runDripTick?: typeof import('../../bulk-emailing/worker/send-engine/engine.js').runDripTick } }).default?.runDripTick
    const broadcastBinding = (bindMod as { broadcastBinding?: unknown }).broadcastBinding
      ?? (bindMod as { default?: { broadcastBinding?: unknown } }).default?.broadcastBinding
    if (typeof runDripTick !== 'function' || !broadcastBinding) {
      throw new Error('send-engine modules did not expose runDripTick/broadcastBinding')
    }
    const logger = {
      info: (...a: unknown[]) => console.log('[send-engine]', ...a),
      warn: (...a: unknown[]) => console.warn('[send-engine]', ...a),
      error: (...a: unknown[]) => console.error('[send-engine]', ...a),
    }
    engine = await runDripTick(
      { supabase, logger, config: {
        claimBatch: Number(process.env.SEND_ENGINE_CLAIM_BATCH ?? 1000),
        batchSize: Number(process.env.SEND_ENGINE_BATCH_SIZE ?? 1000),
        budgetMs: Number(process.env.SEND_ENGINE_BUDGET_MS ?? 45000),
        dailyCap: Number(process.env.SEND_ENGINE_DAILY_CAP ?? Number.MAX_SAFE_INTEGER),
        rampPercent: Number(process.env.SEND_ENGINE_RAMP_PERCENT ?? 100),
        replica: process.env.HOSTNAME ?? 'worker',
      } },
      broadcastBinding as never,
    )
    if (engine.claimed) console.log(`[send-engine] broadcast drip: claimed ${engine.claimed}, sent ${engine.sent}, failed ${engine.failed}`)
  } catch (err) {
    console.error('[send-engine] broadcast worker drip failed:', err)
  }

  return { processed, errors, engine }
}
