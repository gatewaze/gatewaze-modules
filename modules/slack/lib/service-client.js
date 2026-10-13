/**
 * Service-role Supabase client for this module's routes and worker.
 *
 * A static import: a dynamic `await import('@supabase/supabase-js')` from a
 * module file resolves against the package's exports map and fails in the
 * worker (see videos-publisher-youtube/lib/service-client.ts).
 *
 * Bypasses RLS, so every caller does its own authorisation.
 */

import { createClient } from '@supabase/supabase-js';

let cached = null;

export function serviceClient() {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
  cached = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return cached;
}
