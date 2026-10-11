// @ts-nocheck — supabase-js resolved at module-host install time.

/**
 * Service-role Supabase client for this module's worker and routes.
 *
 * A STATIC import, not `await import('@supabase/supabase-js')` inside the
 * handler. A dynamic import from a module file resolves against the package's
 * exports map and fails in the worker with "Did you mean to import
 * .../dist/index.cjs?", while this static one resolves fine. event-speakers
 * learned the same thing; see its lib/promo/service-client.ts.
 *
 * Bypasses RLS, so every caller must do its own authorization.
 */

import { createClient } from '@supabase/supabase-js';

let cached: ReturnType<typeof createClient> | null = null;

export function serviceClient() {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
  cached = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return cached;
}
