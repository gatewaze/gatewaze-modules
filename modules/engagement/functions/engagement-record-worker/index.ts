// @ts-nocheck — Deno edge function, runtime types provided by Supabase
/**
 * engagement-record-worker
 *
 * Drains the engagement_outbox in batches, applies rule logic (cooldown,
 * daily cap, idempotency, points lookup), and inserts into engagement_events.
 *
 * Runs on a 30-second cron OR via LISTEN/NOTIFY when outbox rows are inserted.
 *
 * Per spec-engagement-module.md §5.1 + §6.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
})

interface OutboxRow {
  id: string
  signal: string
  person_id: string
  calendar_id: string | null
  event_id: string | null
  source_module: string
  source_record_id: string | null
  occurred_at: string
  metadata: Record<string, unknown>
  attempts: number
}

interface Rule {
  id: string
  signal: string
  default_points: number
  is_enabled: boolean
  cooldown_seconds: number | null
  daily_cap: number | null
}

async function loadRule(signal: string): Promise<Rule | null> {
  const { data } = await supabase
    .from('engagement_rules')
    .select('id, signal, default_points, is_enabled, cooldown_seconds, daily_cap')
    .eq('signal', signal)
    .maybeSingle()
  return (data as Rule) || null
}

/**
 * Apply a single outbox row: look up the rule, apply cooldown/cap/idempotency,
 * and either INSERT an engagement_events row (success) or mark the outbox
 * row as `skipped` with a reason (refused).
 */
async function processRow(row: OutboxRow): Promise<{ ok: boolean; reason?: string }> {
  const rule = await loadRule(row.signal)
  if (!rule) {
    return { ok: false, reason: 'no_rule' }
  }
  if (!rule.is_enabled) {
    return { ok: false, reason: 'rule_disabled' }
  }

  // Cooldown check
  if (rule.cooldown_seconds && rule.cooldown_seconds > 0) {
    const { data: recent } = await supabase
      .from('engagement_events')
      .select('id')
      .eq('person_id', row.person_id)
      .eq('signal', row.signal)
      .gt('occurred_at', new Date(Date.now() - rule.cooldown_seconds * 1000).toISOString())
      .limit(1)
    if (recent && recent.length > 0) {
      return { ok: false, reason: 'cooldown' }
    }
  }

  // Daily cap check
  if (rule.daily_cap && rule.daily_cap > 0) {
    const startOfDay = new Date()
    startOfDay.setUTCHours(0, 0, 0, 0)
    const { data: todayRows } = await supabase
      .from('engagement_events')
      .select('points')
      .eq('person_id', row.person_id)
      .eq('signal', row.signal)
      .gte('occurred_at', startOfDay.toISOString())
    const todayTotal = (todayRows || []).reduce((sum: number, r: any) => sum + (r.points || 0), 0)
    if (todayTotal >= rule.daily_cap) {
      return { ok: false, reason: 'capped' }
    }
  }

  // Insert (idempotency enforced by UNIQUE constraint on (person_id, signal, source_record_id))
  const { data: inserted, error: insertErr } = await supabase
    .from('engagement_events')
    .insert({
      person_id: row.person_id,
      calendar_id: row.calendar_id,
      event_id: row.event_id,
      signal: row.signal,
      source_module: row.source_module,
      source_record_id: row.source_record_id,
      points: rule.default_points,
      metadata: row.metadata,
      occurred_at: row.occurred_at,
    })
    .select('id')
    .single()

  if (insertErr) {
    // Unique violation = duplicate signal, not an error
    if (insertErr.code === '23505' || /duplicate/i.test(insertErr.message)) {
      return { ok: false, reason: 'duplicate' }
    }
    throw insertErr
  }

  // Enqueue badge evaluation for this person
  await supabase
    .from('engagement_badge_eval_queue')
    .insert({
      person_id: row.person_id,
      trigger_event_id: (inserted as any).id,
    })

  return { ok: true }
}

async function drain(): Promise<{ processed: number; errors: number }> {
  // Claim a batch atomically
  const { data: batch, error: dequeueErr } = await supabase.rpc('engagement_dequeue_batch', { p_limit: 100 })
  if (dequeueErr) {
    console.error('engagement_dequeue_batch failed:', dequeueErr)
    return { processed: 0, errors: 1 }
  }

  const rows = (batch || []) as OutboxRow[]
  let processed = 0
  let errors = 0

  for (const row of rows) {
    try {
      const result = await processRow(row)
      if (result.ok) {
        await supabase
          .from('engagement_outbox')
          .update({
            status: 'processed',
            processed_at: new Date().toISOString(),
          })
          .eq('id', row.id)
      } else {
        // Refused (duplicate, cooldown, cap, disabled, etc.) — mark as skipped
        await supabase
          .from('engagement_outbox')
          .update({
            status: 'skipped',
            processed_at: new Date().toISOString(),
            last_error: result.reason,
          })
          .eq('id', row.id)
      }
      processed++
    } catch (err: any) {
      errors++
      const nextAttempts = (row.attempts || 0) + 1
      await supabase
        .from('engagement_outbox')
        .update({
          status: nextAttempts >= 5 ? 'failed' : 'pending',
          attempts: nextAttempts,
          last_error: err?.message || String(err),
        })
        .eq('id', row.id)
    }
  }

  return { processed, errors }
}

async function handler(_req: Request): Promise<Response> {
  const result = await drain()
  return new Response(
    JSON.stringify({ data: result, error: null }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

Deno.serve(handler)
