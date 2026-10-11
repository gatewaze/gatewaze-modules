/**
 * Stateless HMAC tickets for the mint / PUT / complete upload flow.
 *
 * The editor's browser PUTs the file straight to storage with a signed URL, so
 * the API never sees the bytes. That is the only reason a 2GB talk recording
 * works at all: a single POST through Express cannot resume and dies against
 * the 50MB body limit in `packages/api/src/server.ts`.
 *
 * But it means the `complete` call arrives carrying only what the client
 * chooses to send, and the client is a third-party editor's browser. So the
 * mint step signs the facts it established (which asset, which path, what mime
 * type, what size cap) into a ticket, and `complete` trusts the ticket rather
 * than the request body. Nothing from the body reaches a row except through a
 * verified ticket.
 *
 * Deliberately a copy of `event-media/lib/upload-tickets.ts` rather than an
 * import. Server-side cross-module imports are resolved per snapshot at deploy
 * time, and a missing sibling checkout 404s the whole route path. That trap is
 * recorded in event-media's own copy for the same reason.
 *
 * The signing key is a domain-separated subkey of SUPABASE_JWT_SECRET, so a
 * video ticket can never be replayed as an event-media photo ticket even
 * though both derive from the same root secret.
 */

import { createHmac, timingSafeEqual } from 'crypto';

/** Domain separation. Changing this string invalidates every live ticket. */
const TICKET_KEY_INFO = 'videos-upload-ticket-v1';

/** Two hours: long enough for a slow 2GB upload, short enough to matter. */
export const TICKET_TTL_SECONDS = 2 * 60 * 60;

export interface TicketPayload {
  /** video_assets.id */
  asset_id: string;
  /** video_upload_sessions.id */
  session_id: string;
  storage_bucket: string;
  storage_path: string;
  /** The mime type claimed at mint and enforced at complete. */
  mime_type: string;
  /** Hard ceiling for the stored object, enforced at complete. */
  max_bytes: number;
  /** Who minted it, so complete cannot be replayed by a different user. */
  user_id: string;
  /** Unix seconds. */
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * The signing key, derived from the platform JWT secret.
 *
 * Returns null when the secret is absent, and every caller treats that as
 * "uploads unavailable" rather than falling back to an unsigned ticket. A
 * ticket that is not signed is not a ticket.
 */
function signingKey(): string | null {
  // Both names, in this order, matching event-media's getTicketSecret(). It
  // matters: neither AAIF prod nor the local stack actually sets
  // SUPABASE_JWT_SECRET — both set JWT_SECRET — so reading only the first
  // name makes uploads unavailable everywhere. I found that by getting a 503
  // from mint on a real run rather than by reading the env.
  const secret = process.env.SUPABASE_JWT_SECRET ?? process.env.JWT_SECRET ?? '';
  if (!secret) return null;
  return createHmac('sha256', secret).update(TICKET_KEY_INFO).digest('hex');
}

export function ticketsAvailable(): boolean {
  return signingKey() !== null;
}

/** Sign a payload. Throws when no secret is configured, which fails closed. */
export function mintTicket(payload: Omit<TicketPayload, 'exp'>, nowMs = Date.now()): string {
  const key = signingKey();
  if (!key) throw new Error('SUPABASE_JWT_SECRET is not set — cannot mint an upload ticket');
  const full: TicketPayload = { ...payload, exp: Math.floor(nowMs / 1000) + TICKET_TTL_SECONDS };
  const body = b64url(Buffer.from(JSON.stringify(full), 'utf8'));
  const sig = b64url(createHmac('sha256', key).update(body).digest());
  return `${body}.${sig}`;
}

export type TicketError = 'unavailable' | 'malformed' | 'bad_signature' | 'expired';

/**
 * Verify and decode. Returns the payload, or an error code — never throws, and
 * never returns a payload it has not authenticated.
 *
 * The signature is compared with timingSafeEqual. A length check comes first
 * because timingSafeEqual throws on a length mismatch, and the length of an
 * HMAC-SHA256 is not a secret.
 */
export function verifyTicket(
  ticket: unknown,
  nowMs = Date.now(),
): { ok: true; payload: TicketPayload } | { ok: false; error: TicketError } {
  const key = signingKey();
  if (!key) return { ok: false, error: 'unavailable' };
  if (typeof ticket !== 'string' || ticket.length > 4096) return { ok: false, error: 'malformed' };

  const dot = ticket.indexOf('.');
  if (dot <= 0 || dot === ticket.length - 1) return { ok: false, error: 'malformed' };
  const body = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);
  if (ticket.indexOf('.', dot + 1) !== -1) return { ok: false, error: 'malformed' };

  const expected = createHmac('sha256', key).update(body).digest();
  const given = fromB64url(sig);
  if (given.length !== expected.length) return { ok: false, error: 'bad_signature' };
  if (!timingSafeEqual(given, expected)) return { ok: false, error: 'bad_signature' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromB64url(body).toString('utf8'));
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'malformed' };

  const p = parsed as Partial<TicketPayload>;
  const strings: Array<keyof TicketPayload> = [
    'asset_id', 'session_id', 'storage_bucket', 'storage_path', 'mime_type', 'user_id',
  ];
  for (const k of strings) {
    if (typeof p[k] !== 'string' || !(p[k] as string).length) return { ok: false, error: 'malformed' };
  }
  if (typeof p.max_bytes !== 'number' || !Number.isFinite(p.max_bytes) || p.max_bytes <= 0) {
    return { ok: false, error: 'malformed' };
  }
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return { ok: false, error: 'malformed' };
  if (p.exp * 1000 < nowMs) return { ok: false, error: 'expired' };

  return { ok: true, payload: p as TicketPayload };
}
