// @ts-nocheck — the supabase client is host-provided.

/**
 * This module's config and its OAuth client, shared by the routes and both
 * workers so there is one reading of them.
 *
 * A failed read throws. Returning "not configured" instead would tell an
 * operator to re-enter credentials that are fine, and would log nothing.
 */

import { CLIENT_ID_RE, readClientSecret } from './settings.js';

export async function readModuleConfig(supabase): Promise<Record<string, unknown>> {
  const { data, error } = await supabase
    .from('installed_modules')
    .select('config')
    .eq('id', 'videos-publisher-youtube')
    .maybeSingle();
  if (error) throw new Error(`module settings unreadable: ${error.message}`);
  return (data?.config ?? {}) as Record<string, unknown>;
}

/**
 * The OAuth client, or null when it is not configured. A sealed secret that
 * cannot be unsealed counts as not configured: its ciphertext is never sent
 * to Google as the secret.
 */
export function clientFromConfig(cfg: Record<string, unknown>): { clientId: string; clientSecret: string } | null {
  const clientId = String(cfg.clientId ?? '');
  const clientSecret = readClientSecret(cfg.clientSecret);
  if (!CLIENT_ID_RE.test(clientId) || !clientSecret) return null;
  return { clientId, clientSecret };
}

export async function loadClientCredentials(supabase): Promise<{ clientId: string; clientSecret: string } | null> {
  return clientFromConfig(await readModuleConfig(supabase));
}
