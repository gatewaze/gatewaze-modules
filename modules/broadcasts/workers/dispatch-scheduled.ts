import type { Job } from 'bullmq'

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
  return { processed: result.processed ?? 0, errors: result.errors ?? [] }
}
