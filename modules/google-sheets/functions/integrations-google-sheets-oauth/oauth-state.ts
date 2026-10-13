/**
 * Pure helpers for the Google Sheets OAuth flow: the signed `state` value and
 * the return-URL check. Kept apart from index.ts so they can be unit tested
 * under Node (vitest) as well as run under Deno. They use only Web Crypto,
 * TextEncoder and btoa/atob, which both runtimes provide.
 *
 * Why the state is signed: the callback is a public URL that Google sends a
 * browser to, so it cannot check a bearer token. Before this, `state` was
 * plain base64 JSON, so anyone could forge one. That let a crafted callback
 * bind Google tokens to any event, and send the browser to any site through
 * `returnUrl`. Now the authorize step, which does check the caller, signs the
 * state with HMAC-SHA256, and the callback refuses any state it did not sign,
 * any state older than STATE_TTL_MS, and any return URL that is not ours.
 *
 * The signing key is GOOGLE_SHEETS_CLIENT_SECRET, which the function already
 * needs for the code exchange, so no new secret has to be deployed. The MAC
 * input starts with a fixed label so a value signed here can never be
 * mistaken for anything else signed with that secret.
 */

export const STATE_TTL_MS = 10 * 60 * 1000;
// A state stamped this far in the future is refused; it allows for small
// clock differences between function instances.
const MAX_CLOCK_SKEW_MS = 60 * 1000;
const STATE_VERSION = 1;
const MAC_LABEL = 'gatewaze.google-sheets.oauth-state.v1.';
const MAX_RETURN_LENGTH = 2048;

export const NOTIFICATION_TYPES = ['registration', 'speaker_submission'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/** What the callback trusts once the signature checks out. */
export interface OAuthState {
  v: number;
  /** events.event_id the tokens are stored against */
  e: string;
  /** notification type the tokens are stored against */
  t: NotificationType;
  /** return target, already checked by safeReturnTarget */
  r: string;
  /** auth user id of the admin who started the flow */
  u: string;
  /** issued at, epoch milliseconds */
  iat: number;
  /** random nonce so no two states are alike */
  n: string;
}

export type OAuthStateInput = Pick<OAuthState, 'e' | 't' | 'r' | 'u'>;

const encoder = new TextEncoder();

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function mac(secret: string, body: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(MAC_LABEL + body)));
}

/** Compares in time that depends only on the length, never on where bytes differ. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Signs a state for the authorize redirect. Throws when the secret is empty,
 * so a missing secret can never produce a state that verifies.
 */
export async function signState(
  input: OAuthStateInput,
  secret: string,
  now: number = Date.now(),
): Promise<string> {
  if (!secret) throw new Error('OAuth state secret is not configured');
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const payload: OAuthState = {
    v: STATE_VERSION,
    e: input.e,
    t: input.t,
    r: input.r,
    u: input.u,
    iat: now,
    n: bytesToB64url(nonce),
  };
  const body = bytesToB64url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${bytesToB64url(await mac(secret, body))}`;
}

function isOAuthState(value: unknown): value is OAuthState {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    s.v === STATE_VERSION &&
    typeof s.e === 'string' && s.e !== '' &&
    isNotificationType(s.t) &&
    typeof s.r === 'string' &&
    typeof s.u === 'string' && s.u !== '' &&
    typeof s.n === 'string' && s.n !== '' &&
    typeof s.iat === 'number' && Number.isFinite(s.iat)
  );
}

/** Why a state was refused. Safe to log: it never contains the token. */
export type StateRejection =
  | 'no_secret'
  | 'malformed'
  | 'bad_signature'
  | 'bad_payload'
  | 'expired'
  | 'issued_in_future';

/**
 * Checks a state and says why it was refused, so the callback can log forged
 * or expired states. Accepts only a state signed with `secret`, well formed,
 * and younger than STATE_TTL_MS; the unsigned states issued before signing
 * existed are refused as malformed.
 */
export async function checkState(
  token: string | null | undefined,
  secret: string,
  now: number = Date.now(),
): Promise<{ state: OAuthState } | { rejected: StateRejection }> {
  if (!secret) return { rejected: 'no_secret' };
  if (typeof token !== 'string' || token.length > 8192) return { rejected: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2) return { rejected: 'malformed' };
  const [body, sig] = parts;
  const given = b64urlToBytes(sig);
  if (!body || !given) return { rejected: 'malformed' };
  if (!constantTimeEqual(given, await mac(secret, body))) return { rejected: 'bad_signature' };

  const raw = b64urlToBytes(body);
  if (!raw) return { rejected: 'bad_payload' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { rejected: 'bad_payload' };
  }
  if (!isOAuthState(parsed)) return { rejected: 'bad_payload' };
  if (parsed.iat > now + MAX_CLOCK_SKEW_MS) return { rejected: 'issued_in_future' };
  if (now - parsed.iat > STATE_TTL_MS) return { rejected: 'expired' };
  return { state: parsed };
}

/** checkState without the reason: the state, or null. */
export async function verifyState(
  token: string | null | undefined,
  secret: string,
  now: number = Date.now(),
): Promise<OAuthState | null> {
  const result = await checkState(token, secret, now);
  return 'state' in result ? result.state : null;
}

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

// Control characters and backslashes are refused anywhere: browsers read
// "/\host" and "/<TAB>/host" as a different host.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_CHARS = /[\\\x00-\x1f\x7f]/;

/**
 * Where the browser may go after the callback. Accepts a same-origin path
 * ("/events/abc?tab=x"), or an absolute http(s) URL whose origin is exactly
 * siteUrl's origin or one of allowedOrigins. Anything else, including "//host",
 * "/\host", control characters and other schemes, falls back to "/".
 *
 * A path is returned normalised (dot segments resolved), and refused if it
 * then starts with "//": "/..//evil.example" would otherwise come back as a
 * path that a later relative resolution reads as another host.
 *
 * The result is resolved against siteUrl by the caller, so a path lands on
 * the admin exactly as it did before this check existed.
 */
export function safeReturnTarget(
  raw: unknown,
  siteUrl: string,
  allowedOrigins: ReadonlyArray<string | null | undefined> = [],
): string {
  const fallback = '/';
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_RETURN_LENGTH) return fallback;
  if (UNSAFE_CHARS.test(raw)) return fallback;
  const siteOrigin = originOf(siteUrl);
  if (!siteOrigin) return fallback;

  if (raw.startsWith('/')) {
    if (raw.startsWith('//')) return fallback;
    try {
      const u = new URL(raw, siteOrigin);
      if (u.origin !== siteOrigin || u.pathname.startsWith('//')) return fallback;
      return u.pathname + u.search + u.hash;
    } catch {
      return fallback;
    }
  }

  const target = originOf(raw);
  if (!target) return fallback;
  const allowed = new Set<string>([siteOrigin]);
  for (const o of allowedOrigins) {
    const origin = originOf(o);
    if (origin) allowed.add(origin);
  }
  if (!allowed.has(target)) return fallback;
  const u = new URL(raw);
  return u.pathname.startsWith('//') ? fallback : u.href;
}
