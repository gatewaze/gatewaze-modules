/**
 * BullMQ handler for content-keywords:break-stale-leases.
 *
 * Every 5 min: marks recompute jobs in `running` status as `failed` if
 * their lease has expired (heartbeat lost). Releases the lease so a
 * fresh recompute can acquire it.
 */

import { createClient } from '@supabase/supabase-js';

let _supabase = null;
function supabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('[ck:break-leases] missing SUPABASE env');
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

export default async function handler(_job) {
  const sb = supabase();
  const { data, error } = await sb.rpc('ck_break_stale_leases');
  if (error) throw error;
  return { broken: data ?? 0 };
}
