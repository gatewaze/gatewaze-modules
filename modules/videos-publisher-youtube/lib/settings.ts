/**
 * The OAuth client settings: what an operator may write, and how the stored
 * secret is read back.
 *
 * Kept free of express and supabase so the rules can be tested directly.
 */

import { isSealed, unsealSecret } from './secret-envelope.js';

export const CLIENT_ID_RE = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
const SECRET_MIN = 10;
const SECRET_MAX = 200;

export interface SettingsPatch {
  clientId?: string;
  clientSecret?: string;
}

/**
 * Validate a settings save. Only the two known fields are read, so nothing
 * else in the body can reach installed_modules.config. An omitted or empty
 * secret means "keep the one already stored", because the form never shows
 * the stored secret and so can never send it back.
 */
export function parseSettingsPatch(body: unknown): { patch: SettingsPatch } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Expected a JSON object.' };
  const b = body as Record<string, unknown>;
  const patch: SettingsPatch = {};

  if (b.clientId !== undefined) {
    if (typeof b.clientId !== 'string') return { error: 'clientId must be a string.' };
    const id = b.clientId.trim();
    if (!CLIENT_ID_RE.test(id)) {
      return { error: 'That is not a Google OAuth client ID. It ends in .apps.googleusercontent.com.' };
    }
    patch.clientId = id;
  }

  if (b.clientSecret !== undefined && b.clientSecret !== '') {
    if (typeof b.clientSecret !== 'string') return { error: 'clientSecret must be a string.' };
    const secret = b.clientSecret.trim();
    if (secret.length < SECRET_MIN || secret.length > SECRET_MAX || /\s/.test(secret)) {
      return { error: 'That does not look like an OAuth client secret.' };
    }
    patch.clientSecret = secret;
  }

  if (!patch.clientId && !patch.clientSecret) return { error: 'Nothing to save.' };
  return { patch };
}

/**
 * The stored client secret as plaintext, or null.
 *
 * A sealed value that cannot be unsealed (wrong or missing key) is null, never
 * the ciphertext itself: sending the envelope to Google as a secret would fail
 * in a confusing way and put the envelope in Google's logs. A legacy
 * plaintext value is passed through.
 */
export function readClientSecret(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  if (isSealed(raw)) return unsealSecret(raw);
  return raw;
}
