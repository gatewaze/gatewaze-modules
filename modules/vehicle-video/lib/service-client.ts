/**
 * Shared service-role Supabase client for the workers/API (spec §5 RLS: the
 * module drives everything through the service-role client).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serviceClient(): any {
  // Lazy import so the module doesn't hard-require supabase-js at load time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export function envInt(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}
