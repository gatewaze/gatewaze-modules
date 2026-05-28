/**
 * BullMQ handler for content-keywords:drain-queue.
 *
 * Drains content_keyword_match_queue in batches via ck_drain_queue,
 * processes each row (evaluate or delete), commits via
 * ck_complete_queue_row, or fails via ck_fail_queue_row.
 *
 * Triggered: per-INSERT push from base table triggers, plus 5s recurring.
 */

import { createClient } from '@supabase/supabase-js';

let _supabase = null;
function supabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('[ck:drain-queue] missing SUPABASE env');
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

export default async function handler(_job) {
  const sb = supabase();
  const batchSize = 200;

  const { data: rows, error } = await sb.rpc('ck_drain_queue', { p_batch_size: batchSize });
  if (error) throw new Error(`ck_drain_queue failed: ${error.message}`);
  if (!rows || rows.length === 0) return { processed: 0 };

  let processed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      if (row.op === 'delete') {
        await sb.from('content_keyword_item_state')
          .delete()
          .eq('content_type', row.content_type)
          .eq('content_id', row.content_id);
      } else {
        const { error: evalErr } = await sb.rpc('ck_evaluate_item', {
          p_content_type: row.content_type,
          p_content_id: row.content_id,
        });
        if (evalErr) throw evalErr;
      }
      await sb.rpc('ck_complete_queue_row', {
        p_content_type: row.content_type,
        p_content_id: row.content_id,
      });
      processed++;
    } catch (err) {
      failed++;
      try {
        await sb.rpc('ck_fail_queue_row', {
          p_content_type: row.content_type,
          p_content_id: row.content_id,
          p_error: String(err?.message ?? err).slice(0, 1000),
        });
      } catch (markErr) {
        console.error('[ck:drain-queue] failed to mark queue row failed', markErr);
      }
    }
  }

  return { processed, failed };
}
