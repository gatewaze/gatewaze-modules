import type { Job } from 'bullmq';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface DispatchJobData {
  kind: string;
}

/**
 * Heartbeat that fires due scheduled newsletter sends.
 *
 * Scheduling is DB-as-source-of-truth: a scheduled send is just a
 * `newsletter_sends` row with `status='scheduled'` and a `scheduled_at`.
 * This cron worker runs every 60s and asks the `newsletter-send` edge
 * function to process any rows that have come due
 * (`{ process_scheduled: true }`) — exactly the call pg_cron would have
 * made, but driven by BullMQ/Redis so it works on every deploy target
 * (Docker, k8s, cloud + self-hosted Supabase) without relying on the
 * pg_cron / pg_net extensions being installed.
 *
 * The edge function owns the actual send logic (single implementation):
 * it selects `status='scheduled' AND scheduled_at <= now()`, flips each
 * to 'sending', and dispatches. Overlapping ticks are safe — the status
 * flip plus the `FOR UPDATE SKIP LOCKED` recipient claim guard against
 * double-sends, so this worker only needs to be a dumb trigger.
 */
export default async function handleDispatchScheduled(_job: Job<DispatchJobData>) {
  const res = await fetch(`${supabaseUrl}/functions/v1/newsletter-send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${supabaseServiceKey}`,
      apikey: supabaseServiceKey,
    },
    body: JSON.stringify({ process_scheduled: true }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // Throw so BullMQ records the failure and retries on the next tick.
    throw new Error(`newsletter-send process_scheduled failed (${res.status}): ${detail}`);
  }

  const result = (await res.json().catch(() => ({}))) as {
    processed?: number;
    errors?: string[];
  };
  if (result.errors && result.errors.length > 0) {
    console.error('[newsletter:dispatch-scheduled] send errors:', result.errors);
  }
  if (result.processed) {
    console.log(`[newsletter:dispatch-scheduled] dispatched ${result.processed} due send(s)`);
  }
  return { processed: result.processed ?? 0, errors: result.errors ?? [] };
}
