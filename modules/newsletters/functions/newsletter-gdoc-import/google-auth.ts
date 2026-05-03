/**
 * Google API auth for Docs/Drive access.
 *
 * Supports two modes:
 * 1. Public docs — uses a simple API key (GOOGLE_API_KEY) or no auth at all
 * 2. Private docs — uses OAuth refresh token flow
 *
 * For publicly shared Google Docs, the Docs API can be called with just
 * an API key appended as ?key=... — no OAuth needed.
 */

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Check if OAuth credentials are configured.
 */
export function hasOAuthConfig(): boolean {
  const clientId = Deno.env.get('GOOGLE_SHEETS_CLIENT_ID') || Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_SHEETS_CLIENT_SECRET') || Deno.env.get('GOOGLE_CLIENT_SECRET');
  const refreshToken = Deno.env.get('GOOGLE_SHEETS_REFRESH_TOKEN') || Deno.env.get('GOOGLE_REFRESH_TOKEN');
  return !!(clientId && clientSecret && refreshToken);
}

/**
 * Get the Google API key for public doc access (no OAuth required).
 */
export function getApiKey(): string | null {
  return Deno.env.get('GOOGLE_API_KEY') || null;
}

/**
 * Get auth headers and query params for Google API requests.
 * - If OAuth is configured, returns an Authorization header.
 * - If only an API key is available, returns a ?key= query param.
 * - If neither, returns empty (for truly public docs, the API may still work).
 */
export async function getGoogleAuth(): Promise<{
  headers: Record<string, string>;
  queryParams: Record<string, string>;
}> {
  // Try OAuth first (for private docs)
  if (hasOAuthConfig()) {
    const token = await getGoogleAccessToken();
    return {
      headers: { Authorization: `Bearer ${token}` },
      queryParams: {},
    };
  }

  // Fall back to API key (for public docs)
  const apiKey = getApiKey();
  if (apiKey) {
    return {
      headers: {},
      queryParams: { key: apiKey },
    };
  }

  // No auth at all — will work for some public doc endpoints
  return { headers: {}, queryParams: {} };
}

/**
 * Get an OAuth access token via refresh token.
 */
async function getGoogleAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cachedToken.token;
  }

  const clientId = Deno.env.get('GOOGLE_SHEETS_CLIENT_ID') || Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_SHEETS_CLIENT_SECRET') || Deno.env.get('GOOGLE_CLIENT_SECRET');
  const refreshToken = Deno.env.get('GOOGLE_SHEETS_REFRESH_TOKEN') || Deno.env.get('GOOGLE_REFRESH_TOKEN');

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google OAuth not configured');
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google OAuth token refresh failed (${response.status}): ${error}`);
  }

  const { access_token, expires_in } = await response.json();
  if (!access_token) {
    throw new Error('No access_token in Google OAuth refresh response');
  }

  cachedToken = {
    token: access_token,
    expiresAt: Date.now() + (expires_in ?? 3600) * 1000,
  };

  return access_token;
}
