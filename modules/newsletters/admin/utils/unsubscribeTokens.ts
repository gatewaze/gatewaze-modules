/**
 * Unsubscribe Token Generator
 *
 * Generates HMAC-signed tokens for one-click unsubscribe links.
 * Token format: base64url(email:list_id:timestamp).signature
 *
 * These tokens are verified by the newsletter-unsubscribe edge function.
 */

/**
 * Generate an HMAC-SHA256 signature
 */
async function hmacSign(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generate a signed unsubscribe token for an email + list combination
 */
export async function generateUnsubscribeToken(
  email: string,
  listId: string,
  hmacSecret: string
): Promise<string> {
  const timestamp = Date.now();
  const payload = `${email}:${listId}:${timestamp}`;
  const encodedPayload = btoa(payload)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const signature = await hmacSign(payload, hmacSecret);
  return `${encodedPayload}.${signature}`;
}

/**
 * Generate a full unsubscribe URL
 */
export function getUnsubscribeUrl(
  supabaseUrl: string,
  token: string
): string {
  return `${supabaseUrl}/functions/v1/newsletter-unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * Generate List-Unsubscribe headers for RFC 8058 one-click unsubscribe
 */
export function getListUnsubscribeHeaders(
  supabaseUrl: string,
  token: string
): { 'List-Unsubscribe': string; 'List-Unsubscribe-Post': string } {
  const url = getUnsubscribeUrl(supabaseUrl, token);
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
