/**
 * Cvent credentials from installed_modules.config.
 *
 * CVENT_CLIENT_ID is a plain string; CVENT_CLIENT_SECRET is declared
 * `encrypted: true` in the manifest, so the platform seals it at rest and we
 * unseal it here. A sealed secret that cannot be unsealed (missing or wrong
 * GATEWAZE_SECRETS_KEY) reads as "not configured" rather than as ciphertext.
 */

import { unsealSecret } from './secret-envelope.js';

export const MODULE_ID = 'cvent';

export interface CventCredentials {
  clientId: string;
  clientSecret: string;
}

export interface CventSyncSettings {
  /** Each worker run stops after this long. */
  budgetMs: number;
  /** Registrations attempted per event per run. */
  batchSize: number;
  /** Failed registrations are retried until this many attempts. */
  maxAttempts: number;
  /** Pause between Cvent calls, to stay under their rate limit. */
  pauseMs: number;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Null when either credential is missing. */
export function parseCredentials(raw: Record<string, unknown> | null | undefined): CventCredentials | null {
  const r = raw ?? {};
  const clientId = str(r.CVENT_CLIENT_ID);
  const clientSecret = unsealSecret(str(r.CVENT_CLIENT_SECRET)) ?? '';
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function parseSyncSettings(raw: Record<string, unknown> | null | undefined): CventSyncSettings {
  const r = raw ?? {};
  return {
    // Capped below the one-minute cron so a run cannot overlap the next one.
    budgetMs: Math.round(num(r.budget_ms, 50_000, 5_000, 55_000)),
    batchSize: Math.round(num(r.batch_size, 100, 1, 1_000)),
    maxAttempts: Math.round(num(r.max_attempts, 5, 1, 20)),
    pauseMs: Math.round(num(r.pause_ms, 500, 0, 5_000)),
  };
}

/** Minimal client shape so this file needs no supabase-js types. */
interface ConfigReader {
  from(table: string): {
    select(cols: string): {
      eq(col: string, v: string): {
        maybeSingle(): Promise<{ data: { config?: Record<string, unknown> | null } | null; error: { message: string } | null }>;
      };
    };
  };
}

export async function loadModuleConfig(supabase: ConfigReader): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.from('installed_modules').select('config').eq('id', MODULE_ID).maybeSingle();
  if (error) throw new Error(`[cvent] could not read module config: ${error.message}`);
  return (data?.config ?? {}) as Record<string, unknown>;
}
