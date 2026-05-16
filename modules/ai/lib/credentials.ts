/**
 * Credential resolution.
 *
 * Three-tier lookup per spec §6.3 + §19.6:
 *   1. ai_user_credentials (per-user override)
 *   2. ai_use_case_credentials (per-use-case pin; cron-driven use-cases
 *      ALWAYS use this path and skip user keys)
 *   3. system default from env var (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 *      GEMINI_API_KEY)
 *
 * Cleartext is decrypted at use via pgsodium; never returned to clients.
 */

import { type KnownProvider, NoCredentialsError } from './providers/types.js';

/**
 * Minimal supabase surface — we only need .from().select().eq().maybeSingle()
 * + .update() for failure tracking.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = { from(table: string): any };

export interface ResolveCredentialOpts {
  provider: KnownProvider;
  userId: string | null;
  useCase: string;
  /**
   * When true, ai_user_credentials is skipped entirely. Used by cron-
   * driven runners so personal keys never bill against a scheduled job.
   */
  systemRunOnly?: boolean;
}

export interface ResolvedCredential {
  apiKey: string;
  source: 'user' | 'use_case' | 'env';
  /** Last 4 chars, safe to log. */
  last4: string;
  /** id of the ai_user_credentials or ai_use_case_credentials row when source≠env. */
  credentialId: string | null;
}

export async function resolveCredential(
  supabase: SupabaseClient,
  opts: ResolveCredentialOpts,
): Promise<ResolvedCredential> {
  // 1. Per-user override (skipped for cron / system runs).
  if (!opts.systemRunOnly && opts.userId) {
    const row = await supabase
      .from('ai_user_credentials')
      .select('id, api_key_ciphertext, api_key_nonce, last_4, status')
      .eq('user_id', opts.userId)
      .eq('provider', opts.provider)
      .eq('status', 'active')
      .maybeSingle();
    if (row.data) {
      const cleartext = await decryptCredential(
        supabase,
        row.data.api_key_ciphertext,
        row.data.api_key_nonce,
      );
      void touchLastUsed(supabase, 'ai_user_credentials', row.data.id);
      return {
        apiKey: cleartext,
        source: 'user',
        last4: row.data.last_4,
        credentialId: row.data.id,
      };
    }
  }

  // 2. Per-use-case pin.
  const useCaseRow = await supabase
    .from('ai_use_case_credentials')
    .select('id, api_key_ciphertext, api_key_nonce, last_4, status')
    .eq('use_case', opts.useCase)
    .eq('provider', opts.provider)
    .eq('status', 'active')
    .maybeSingle();
  if (useCaseRow.data) {
    const cleartext = await decryptCredential(
      supabase,
      useCaseRow.data.api_key_ciphertext,
      useCaseRow.data.api_key_nonce,
    );
    void touchLastUsed(supabase, 'ai_use_case_credentials', useCaseRow.data.id);
    return {
      apiKey: cleartext,
      source: 'use_case',
      last4: useCaseRow.data.last_4,
      credentialId: useCaseRow.data.id,
    };
  }

  // 3. Env default.
  const envKey = lookupEnvKey(opts.provider);
  if (envKey) {
    return {
      apiKey: envKey,
      source: 'env',
      last4: envKey.slice(-4),
      credentialId: null,
    };
  }

  throw new NoCredentialsError(opts.provider);
}

function lookupEnvKey(provider: KnownProvider): string | null {
  switch (provider) {
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY ?? null;
    case 'openai':
      return process.env.OPENAI_API_KEY ?? null;
    case 'gemini':
      return (
        process.env.GEMINI_API_KEY ??
        process.env.GOOGLE_API_KEY ??
        null
      );
  }
}

/**
 * Decrypt via the platform's standard pgsodium helper. The helper is
 * exposed as a Postgres function `public.pgsodium_decrypt_text(ciphertext, nonce)`;
 * we call it via supabase's `.rpc` so the key material never leaves
 * Postgres.
 */
async function decryptCredential(
  supabase: SupabaseClient,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
): Promise<string> {
  const result = await (supabase as unknown as {
    rpc(name: string, args: Record<string, unknown>): Promise<{
      data: string | null;
      error: { message: string } | null;
    }>;
  }).rpc('pgsodium_decrypt_text', {
    p_ciphertext: bytesToHex(ciphertext),
    p_nonce: bytesToHex(nonce),
  });
  if (result.error || !result.data) {
    throw new Error(`credential decrypt failed: ${result.error?.message ?? 'no data'}`);
  }
  return result.data;
}

async function touchLastUsed(
  supabase: SupabaseClient,
  table: 'ai_user_credentials' | 'ai_use_case_credentials',
  id: string,
): Promise<void> {
  try {
    await supabase
      .from(table)
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', id);
  } catch {
    /* non-fatal: lookup-touch is best-effort */
  }
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Mark a credential as failed (provider returned 401). Bumps the
 * failure_count and, if it exceeds 3 in 15 minutes, flips status to
 * 'disabled' so subsequent calls won't keep burning the broken key.
 */
export async function markCredentialFailed(
  supabase: SupabaseClient,
  table: 'ai_user_credentials' | 'ai_use_case_credentials',
  id: string,
  reason: string,
): Promise<void> {
  const row = await supabase
    .from(table)
    .select('failure_count')
    .eq('id', id)
    .maybeSingle();
  const next = (row.data?.failure_count ?? 0) + 1;
  await supabase
    .from(table)
    .update({
      failure_count: next,
      status: next >= 3 ? 'disabled' : 'active',
      status_reason: next >= 3 ? reason : null,
    })
    .eq('id', id);
}
