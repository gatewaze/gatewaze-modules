import type { Job } from 'bullmq'
// Static (not dynamic) import: a bare-specifier `await import('@supabase/...')`
// from this module-file location does not resolve in the worker runtime; a
// top-level import does (matches newsletters/workers/dispatch-scheduled).
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

interface DispatchJobData {
  kind: string
}

interface DueSend {
  id: string
  metadata: Record<string, unknown> | null
}

// If the segment was recalculated within this window we skip the recalc before
// fan-out (avoids a redundant full recompute on every send). Mirrors the prior
// Edge-side fanOutAndStart logic (spec §1.2).
const SEGMENT_FRESHNESS_MS = 60 * 60 * 1000
const BROADCAST_FANOUT_BATCH = Number(process.env.BROADCAST_FANOUT_BATCH ?? 5000)

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
 *   2. For each: best-effort segment recalc, call
 *      `fanout_broadcast_send_recipients` to populate the per-recipient
 *      timing queue, check for empty audience after suppression, flip to
 *      'sending' (or 'failed' with reason).
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
    .select('id, metadata, audience_type, segment_id')
    .eq('status', 'scheduled')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at')
    .limit(10)

  if (selectErr) {
    throw new Error(`[broadcast:dispatch-scheduled] select due sends failed: ${selectErr.message}`)
  }

  // 2. Fan out each due broadcast + flip status.
  for (const send of (due ?? []) as (DueSend & { audience_type?: string; segment_id?: string | null })[]) {
    try {
      // Best-effort segment recalc (matches prior maybeRecalcSegment).
      if (send.audience_type === 'segment' && send.segment_id) {
        try {
          const { data: seg } = await supabase
            .from('segments')
            .select('last_calculated_at')
            .eq('id', send.segment_id)
            .maybeSingle()
          const last = (seg as { last_calculated_at?: string } | null)?.last_calculated_at
          if (!last || Date.now() - new Date(last).getTime() >= SEGMENT_FRESHNESS_MS) {
            const { error: recalcErr } = await supabase.rpc('segments_calculate_members', { p_segment_id: send.segment_id })
            if (recalcErr) console.warn('[broadcast:dispatch-scheduled] segment recalc skipped:', recalcErr.message)
          }
        } catch (err) {
          console.warn('[broadcast:dispatch-scheduled] segment recalc error:', err instanceof Error ? err.message : err)
        }
      }

      // Fan out in keyset-paginated batches so no single RPC approaches the ~8s
      // PostgREST/role statement_timeout (the single-shot fanout of a large
      // audience was cancelled → send marked failed). Each call is a fast (~1s)
      // separate statement; idempotent via the email cursor + ON CONFLICT.
      try {
        let after: string | null = null
        let guard = 0
        for (;;) {
          const { data, error } = await supabase.rpc('fanout_broadcast_send_recipients_batch', {
            p_send_id: send.id,
            p_batch_size: BROADCAST_FANOUT_BATCH,
            p_after_email: after,
          })
          if (error) throw new Error(error.message)
          const row = (Array.isArray(data) ? data[0] : data) as
            | { last_email: string | null; remaining: boolean }
            | null
          if (!row) break
          after = row.last_email ?? after
          if (!row.remaining) break
          if (++guard > 10_000) throw new Error('fanout batch guard tripped')
        }
      } catch (fanoutErr) {
        const msg = `Broadcast ${send.id}: ${fanoutErr instanceof Error ? fanoutErr.message : 'fanout failed'}`
        console.error('[broadcast:dispatch-scheduled] fanout failed:', msg)
        errors.push(msg)
        await supabase
          .from('broadcast_sends')
          .update({ status: 'failed', updated_at: new Date().toISOString() })
          .eq('id', send.id)
        continue
      }

      // Empty audience after suppression → terminal failure with a clear reason
      // baked into metadata (matches prior fanOutAndStart behaviour).
      const { count } = await supabase
        .from('broadcast_send_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('send_id', send.id)
      if ((count ?? 0) === 0) {
        const msg = `Broadcast ${send.id}: 0 deliverable recipients after suppression filtering`
        console.error('[broadcast:dispatch-scheduled]', msg)
        errors.push(msg)
        await supabase
          .from('broadcast_sends')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            metadata: { ...(send.metadata || {}), error: '0 deliverable recipients after suppression filtering' },
            updated_at: new Date().toISOString(),
          })
          .eq('id', send.id)
        continue
      }

      const { error: flipErr } = await supabase
        .from('broadcast_sends')
        .update({
          status: 'sending',
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', send.id)
      if (flipErr) {
        const msg = `Broadcast ${send.id} flip to sending: ${flipErr.message}`
        console.error('[broadcast:dispatch-scheduled]', msg)
        errors.push(msg)
        continue
      }
      processed++
    } catch (err) {
      const msg = `Broadcast ${send.id}: ${err instanceof Error ? err.message : 'unknown error'}`
      console.error('[broadcast:dispatch-scheduled] unexpected:', msg)
      errors.push(msg)
    }
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
