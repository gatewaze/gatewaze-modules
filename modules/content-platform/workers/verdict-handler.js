/**
 * BullMQ handler for content-platform:verdict-handler.
 * Drains content_publish_state_event_queue (any content_type) and calls
 * handle_keyword_verdict_change for each row.
 */

import { createClient } from '@supabase/supabase-js';

let _supabase = null;
function supabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('[content-platform:verdict-handler] missing SUPABASE env');
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;

export default async function handler(_job) {
  const sb = supabase();

  const { data: rows, error: fetchErr } = await sb
    .from('content_publish_state_event_queue')
    .select('id, content_type, content_id, trigger, attempts')
    .is('dead_letter_at', null)
    .lte('next_attempt_at', new Date().toISOString())
    .order('enqueued_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchErr) throw new Error(`fetch queue failed: ${fetchErr.message}`);
  if (!rows || rows.length === 0) return { processed: 0 };

  let processed = 0;
  let failed = 0;
  let deadLettered = 0;

  for (const row of rows) {
    try {
      const { data: outcome, error: rpcErr } = await sb.rpc('handle_keyword_verdict_change', {
        p_content_type: row.content_type,
        p_content_id: row.content_id,
      });
      if (rpcErr) throw rpcErr;

      // Success: drop the queue row.
      const { error: delErr } = await sb
        .from('content_publish_state_event_queue')
        .delete()
        .eq('id', row.id);
      if (delErr) throw delErr;
      processed++;

      if (outcome?.from_state !== outcome?.to_state) {
        console.log(`[content-platform:verdict-handler] ${row.content_type}/${row.content_id}: ${outcome.from_state} -> ${outcome.to_state}${outcome.triage ? ' (triage submitted)' : ''}`);
      }
    } catch (err) {
      failed++;
      const msg = String(err?.message ?? err).slice(0, 1000);
      const nextAttempts = (row.attempts ?? 0) + 1;

      if (nextAttempts >= MAX_ATTEMPTS) {
        // Dead-letter it.
        await sb.from('content_publish_state_event_queue').update({
          attempts: nextAttempts,
          last_error: msg,
          dead_letter_at: new Date().toISOString(),
          dead_letter_reason: msg,
        }).eq('id', row.id);
        deadLettered++;
        console.error(`[content-platform:verdict-handler] dead-lettered ${row.id}: ${msg}`);
      } else {
        // Retry with exponential backoff: 60s, 120s, 240s, 480s.
        const backoffMs = Math.min(60_000 * Math.pow(2, nextAttempts - 1), 60 * 60_000);
        const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
        await sb.from('content_publish_state_event_queue').update({
          attempts: nextAttempts,
          last_error: msg,
          next_attempt_at: nextAttemptAt,
        }).eq('id', row.id);
        console.warn(`[content-platform:verdict-handler] retry ${row.id} (attempt ${nextAttempts}/${MAX_ATTEMPTS}) in ${backoffMs}ms: ${msg}`);
      }
    }
  }

  return { processed, failed, deadLettered };
}
