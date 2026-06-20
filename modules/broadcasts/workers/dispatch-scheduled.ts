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

/**
 * Heartbeat that fires due scheduled broadcast sends + drives the per-recipient
 * drip. Mirrors newsletters:dispatch-scheduled exactly — scheduling is
 * DB-as-source-of-truth (a broadcast_sends row with status='scheduled' and a
 * scheduled_at), and this 60s BullMQ cron is the pg_cron stand-in that works on
 * every deploy target without the pg_cron / pg_net extensions.
 *
 * The broadcast-send edge function owns the logic: it fans out due scheduled
 * broadcasts into the per-recipient timing queue, flips them to 'sending', and
 * drips due rows. Overlapping ticks are safe (status flip + FOR UPDATE SKIP
 * LOCKED claim), so this worker is a dumb trigger.
 */
export default async function handleDispatchScheduled(_job: Job<DispatchJobData>) {
  const res = await fetch(`${supabaseUrl}/functions/v1/broadcast-send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${supabaseServiceKey}`,
      apikey: supabaseServiceKey,
    },
    body: JSON.stringify({ process_scheduled: true }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`broadcast-send process_scheduled failed (${res.status}): ${detail}`)
  }

  const result = (await res.json().catch(() => ({}))) as { processed?: number; errors?: string[] }
  if (result.errors && result.errors.length > 0) {
    console.error('[broadcast:dispatch-scheduled] send errors:', result.errors)
  }
  if (result.processed) {
    console.log(`[broadcast:dispatch-scheduled] dispatched ${result.processed} due broadcast(s)`)
  }

  // Central Sending Service canary: when SEND_ENGINE_USE_WORKER=true the Edge
  // call above did fanout + scheduled processing but SKIPPED its per-recipient
  // drip (see broadcast-send). The Node worker now owns that drip via the shared
  // high-throughput engine. Flag off → this block is skipped and the Edge path
  // dripped as before (behaviour unchanged).
  let engine: { claimed: number; sent: number; failed: number } | null = null
  if (process.env.SEND_ENGINE_USE_WORKER === 'true') {
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
      const supabase = createClient(supabaseUrl, supabaseServiceKey, { auth: { autoRefreshToken: false, persistSession: false } })
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
  }

  return { processed: result.processed ?? 0, errors: result.errors ?? [], engine }
}
