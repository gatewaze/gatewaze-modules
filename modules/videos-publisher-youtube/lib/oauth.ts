/**
 * YouTube OAuth, the account half.
 *
 * Two kinds of credential, kept apart on purpose:
 *
 *   - the OAuth CLIENT (client id and secret) identifies the Gatewaze
 *     install to Google. One per deployment, sealed in the module's own
 *     config via secretsSchema.
 *   - the REFRESH TOKEN identifies one channel. AAIF has two, so this cannot
 *     be app-level, and it is sealed per row on
 *     video_platform_connections.encrypted_credentials.
 *
 * Nothing here logs a token, and nothing returns one to a client. An earlier
 * YouTube integration in this codebase shipped its client secret and refresh
 * token to the browser through VITE_ variables; the functions below take
 * credentials as arguments so there is no path by which that can happen
 * again.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 20_000;

/**
 * The narrowest scopes that still allow upload and reading our own analytics.
 *
 * `youtube.upload` alone cannot set a video's privacy or read its stats, and
 * `youtube.force-ssl` is what the Data API wants for the parts we update.
 * `yt-analytics.readonly` is the metrics half and is read-only by name.
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
] as const;

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
}

/**
 * Where Google sends the browser back.
 *
 * Must match a redirect URI registered on the OAuth client EXACTLY, including
 * the scheme and any trailing path. Built from the API's public base so a
 * deployment cannot accidentally register localhost.
 */
export function redirectUri(apiBaseUrl: string): string {
  return `${String(apiBaseUrl).replace(/\/+$/, '')}/api/modules/videos-publisher-youtube/oauth/callback`;
}

/**
 * The consent URL.
 *
 * `access_type=offline` with `prompt=consent` is what makes Google return a
 * refresh token. Without BOTH, a second authorisation of the same account
 * returns an access token only, and the connection silently cannot be
 * refreshed later — which looks like it worked until the first token expires.
 *
 * `state` is an opaque anti-CSRF value the caller must verify on the way
 * back. Never put anything meaningful in it.
 */
export function authorizeUrl(
  client: ClientCredentials,
  apiBaseUrl: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri(apiBaseUrl),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

async function postForm(body: URLSearchParams): Promise<Record<string, unknown>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: ctl.signal,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // Google puts the useful part in `error`; the description can echo
      // request content, so only the code is surfaced.
      throw new Error(`token endpoint returned ${res.status}: ${String(json.error ?? 'unknown')}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** Exchange the one-time code for a token set. */
export async function exchangeCode(
  client: ClientCredentials,
  apiBaseUrl: string,
  code: string,
): Promise<TokenSet> {
  const json = await postForm(new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri(apiBaseUrl),
    grant_type: 'authorization_code',
    code,
  }));
  const refreshToken = typeof json.refresh_token === 'string' ? json.refresh_token : null;
  if (!refreshToken) {
    // Worth failing loudly: a connection without a refresh token works for
    // an hour and then stops, and the cause is invisible by then.
    throw new Error(
      'Google returned no refresh token. The account was probably already authorised — ' +
      'remove this app at myaccount.google.com/permissions and connect again.',
    );
  }
  return {
    accessToken: String(json.access_token ?? ''),
    refreshToken,
    expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
    scopes: String(json.scope ?? '').split(' ').filter(Boolean),
  };
}

/** Trade the long-lived refresh token for a fresh access token. */
export async function refreshAccessToken(
  client: ClientCredentials,
  refreshToken: string,
): Promise<TokenSet> {
  const json = await postForm(new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }));
  return {
    accessToken: String(json.access_token ?? ''),
    // A refresh response does not re-issue the refresh token; keep the one
    // we already hold.
    refreshToken,
    expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
    scopes: String(json.scope ?? '').split(' ').filter(Boolean),
  };
}

/**
 * Which channel this token actually belongs to.
 *
 * Called straight after the code exchange, because the operator picked an
 * account in Google's UI and we have no other way to know which of the two
 * AAIF channels they chose. Storing the wrong one would publish talks to the
 * wrong audience.
 */
export async function fetchChannel(
  accessToken: string,
): Promise<{ id: string; title: string } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: ctl.signal },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { items?: Array<{ id?: string; snippet?: { title?: string } }> };
    const item = json.items?.[0];
    if (!item?.id) return null;
    return { id: String(item.id), title: String(item.snippet?.title ?? item.id) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether an error from the Data API means the credential is dead.
 *
 * A terminal auth failure must stop and ask a human; a transient one must be
 * retried. Treating the two the same is how a rate limit turns into a
 * disconnected channel, and how a revoked grant turns into an infinite retry.
 */
export function isAuthFailure(status: number, body: string): boolean {
  if (status === 401) return true;
  if (status !== 403) return false;
  // 403 is overloaded: quota exceeded is transient, these are not.
  return /invalid_grant|insufficientPermissions|authError|forbidden/i.test(body);
}
