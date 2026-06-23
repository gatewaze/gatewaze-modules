import type { Job } from 'bullmq';
// Static import (a bare-specifier dynamic import doesn't resolve from a
// /gatewaze-modules file in the worker runtime — see other module workers).
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const BATCHES_PER_TICK = Number(process.env.SENDGRID_RECONCILE_BATCHES ?? 10);

interface DispatchJobData { kind: string }

interface ActivityMsg { to_email: string; status: string; opens_count: number; clicks_count: number; last_event_time: string }

/**
 * Pull recent message statuses for one batch from the SendGrid Email Activity
 * API (msg_id LIKE "<batchId>%"). Returns [] on any error (no add-on / 429 /
 * network) so a transient failure just retries next tick.
 */
async function queryBatchMessages(pmid: string): Promise<ActivityMsg[]> {
  const q = encodeURIComponent(`msg_id LIKE "${pmid}%"`);
  try {
    const res = await fetch(`https://api.sendgrid.com/v3/messages?query=${q}&limit=1000`, {
      headers: { Authorization: `Bearer ${SENDGRID_API_KEY}` },
    });
    if (!res.ok) return [];
    const json = (await res.json().catch(() => ({}))) as { messages?: Array<Record<string, unknown>> };
    return (json.messages ?? []).map((m) => ({
      to_email: String(m.to_email ?? ''),
      status: String(m.status ?? ''),
      opens_count: Number(m.opens_count ?? 0),
      clicks_count: Number(m.clicks_count ?? 0),
      last_event_time: String(m.last_event_time ?? new Date().toISOString()),
    })).filter((m) => m.to_email);
  } catch {
    return [];
  }
}

/**
 * Reconcile email_send_log to its real SendGrid delivery status (delivered /
 * opened / clicked / bounced). Backstops the Event Webhook — and on localhost,
 * where SendGrid can't reach the webhook, it's the only path. The sending UI
 * reads email_send_log, so reconciled rows surface there automatically.
 */
export default async function handleReconcileSendgridStatus(_job: Job<DispatchJobData>) {
  if (!SENDGRID_API_KEY) return { skipped: 'no SENDGRID_API_KEY' };
  const supabase = createClient(supabaseUrl, supabaseServiceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: batches, error } = await supabase.rpc('sendgrid_batches_needing_reconcile', { p_limit: BATCHES_PER_TICK });
  if (error) { console.error('[reconcile-sendgrid] batch list failed:', error.message); return { error: error.message }; }

  let batchCount = 0; let rows = 0;
  for (const b of (batches ?? []) as Array<{ provider_message_id: string }>) {
    const messages = await queryBatchMessages(b.provider_message_id);
    if (messages.length === 0) continue;
    const { data: n, error: rpcErr } = await supabase.rpc('reconcile_email_send_log', { p_provider_message_id: b.provider_message_id, p_messages: messages });
    if (rpcErr) { console.error('[reconcile-sendgrid] rpc failed:', rpcErr.message); continue; }
    batchCount++; rows += typeof n === 'number' ? n : 0;
    await new Promise((r) => setTimeout(r, 300)); // gentle on the Activity API rate limit
  }
  if (batchCount) console.log(`[reconcile-sendgrid] reconciled ${batchCount} batch(es), ${rows} row(s) advanced`);
  return { batches: batchCount, rows };
}
