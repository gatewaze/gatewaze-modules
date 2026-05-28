/**
 * BullMQ handler for content-keywords:scan-stale.
 *
 * Every 15 min: for each registered adapter, enqueue (a) stale items
 * (item_state.ruleset_version < current) and (b) missing-state items
 * (rows in base table without state). Bounded batches (1000 each per
 * scan tick).
 */

import { createClient } from '@supabase/supabase-js';

let _supabase = null;
function supabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('[ck:scan-stale] missing SUPABASE env');
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

export default async function handler(_job) {
  const sb = supabase();

  const { data: adapters, error } = await sb
    .from('content_keyword_adapters')
    .select('content_type');
  if (error) throw error;

  let totalEnqueued = 0;
  for (const a of (adapters ?? [])) {
    try {
      const { data, error: scanErr } = await sb.rpc('ck_scan_stale_and_missing', {
        p_content_type: a.content_type,
        p_batch_size: 1000,
      });
      if (scanErr) throw scanErr;
      totalEnqueued += data ?? 0;
    } catch (err) {
      console.error(`[ck:scan-stale] error for ${a.content_type}:`, err?.message ?? err);
    }
  }

  // Refresh adapter stats while we're at it.
  try { await sb.rpc('ck_refresh_adapter_stats', { p_content_type: null }); } catch {}

  return { adapters: adapters?.length ?? 0, total_enqueued: totalEnqueued };
}
