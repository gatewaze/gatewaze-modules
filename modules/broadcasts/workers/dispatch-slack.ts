import type { Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'

/**
 * The Slack broadcast drip: a 60s heartbeat that sends due Slack recipients
 * one direct message at a time through the shared send engine.
 *
 * Scheduled Slack sends are started (segment refresh, fan-out, status flip) by
 * broadcasts:dispatch-scheduled like any other broadcast; only the drip is
 * separate, so Slack's pacing never slows an email send.
 *
 * Pacing: one message every SLACK_BROADCAST_INTERVAL_MS (default 3s, about
 * 1,200 an hour), well inside Slack's limits for posting to different DMs.
 * Each tick claims only what fits in its budget and stops before the budget
 * runs out, so the next tick never overlaps it.
 */
export const SLACK_INTERVAL_MS = Math.max(1000, Number(process.env.SLACK_BROADCAST_INTERVAL_MS ?? 3000))
export const SLACK_BUDGET_MS = 40_000
// Retryable Slack errors (rate limits, outages) are tried this many times.
export const SLACK_MAX_ATTEMPTS = 5

export function slackClaimSize(intervalMs: number, budgetMs: number): number {
  return Math.max(1, Math.floor(budgetMs / intervalMs))
}

export default async function handleDispatchSlack(_job: Job) {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const [engMod, bindMod] = await Promise.all([
    import('../../bulk-emailing/worker/send-engine/engine.js'),
    import('./slack-send-binding.js'),
  ])
  // Interop-safe, as in dispatch-scheduled.ts.
  type Engine = typeof import('../../bulk-emailing/worker/send-engine/engine.js')
  const runDripTick = (engMod as Partial<Engine>).runDripTick ?? (engMod as { default?: Partial<Engine> }).default?.runDripTick
  const binding = (bindMod as { broadcastSlackBinding?: unknown }).broadcastSlackBinding
    ?? (bindMod as { default?: { broadcastSlackBinding?: unknown } }).default?.broadcastSlackBinding
  if (typeof runDripTick !== 'function' || !binding) {
    throw new Error('send-engine modules did not expose runDripTick/broadcastSlackBinding')
  }
  const logger = {
    info: (...a: unknown[]) => console.log('[send-engine:slack]', ...a),
    warn: (...a: unknown[]) => console.warn('[send-engine:slack]', ...a),
    error: (...a: unknown[]) => console.error('[send-engine:slack]', ...a),
  }
  const claim = slackClaimSize(SLACK_INTERVAL_MS, SLACK_BUDGET_MS)
  const engine = await runDripTick(
    { supabase, logger, config: {
      claimBatch: claim,
      batchSize: 1,
      budgetMs: SLACK_BUDGET_MS,
      dailyCap: Number(process.env.SEND_ENGINE_DAILY_CAP ?? Number.MAX_SAFE_INTEGER),
      rampPercent: 100,
      replica: process.env.HOSTNAME ?? 'worker',
      minIntervalMs: SLACK_INTERVAL_MS,
      maxAttempts: SLACK_MAX_ATTEMPTS,
    } },
    binding as never,
  )
  if (engine.claimed) console.log(`[send-engine:slack] broadcast drip: claimed ${engine.claimed}, sent ${engine.sent}, failed ${engine.failed}`)
  return { engine }
}
