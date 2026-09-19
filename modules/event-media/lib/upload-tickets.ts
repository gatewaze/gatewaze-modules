/**
 * Stateless HMAC upload tickets for the guest-upload flow.
 *
 * Why stateless: autodb (the first production user) runs zero
 * workers/schedulers, so there is no cleanup cron for a staging table
 * of in-flight uploads. Instead the mint step returns a signed ticket
 * whose payload carries everything the complete step needs; the server
 * trusts nothing from the complete call except the ticket itself.
 * Precedent: the newsletter-unsubscribe HMAC token.
 *
 * Format: base64url(JSON payload) + '.' + base64url(HMAC-SHA256(payload)).
 * Secret: SUPABASE_JWT_SECRET (already present in every API deployment).
 *
 * Per spec-event-media-guest-uploads §5.3.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const TICKET_TTL_SECONDS = 2 * 60 * 60; // matches the signed-URL TTL

export interface UploadTicketPayload {
  media_id: string;
  code: string; // upload-link short_code the ticket was minted under
  event_id: string;
  storage_path: string;
  mime_type: string;
  max_bytes: number; // per-kind cap at mint time; complete enforces +10% slack
  guest_name: string;
  client_id: string;
  captured: boolean;
  exp: number; // unix seconds
}

export type TicketVerifyResult =
  | { ok: true; payload: UploadTicketPayload }
  | { ok: false; error: 'invalid_ticket' | 'ticket_expired' };

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

const TICKET_KEY_INFO = 'event-media-upload-ticket-v1';

export function getTicketSecret(): string {
  const secret = process.env.SUPABASE_JWT_SECRET ?? process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('SUPABASE_JWT_SECRET not set; guest upload tickets cannot be minted or verified');
  }
  // Domain-separated subkey: never sign tickets with the raw JWT
  // secret itself, so ticket bytes can never be confused with (or
  // brute-force oracle for) real auth JWTs (security review 2026-09-19).
  return createHmac('sha256', secret).update(TICKET_KEY_INFO).digest('hex');
}

export function mintTicket(payload: UploadTicketPayload, secret: string = getTicketSecret()): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyTicket(
  ticket: unknown,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  secret: string = getTicketSecret(),
): TicketVerifyResult {
  if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 4096) {
    return { ok: false, error: 'invalid_ticket' };
  }
  const dot = ticket.indexOf('.');
  if (dot <= 0 || dot === ticket.length - 1 || ticket.indexOf('.', dot + 1) !== -1) {
    return { ok: false, error: 'invalid_ticket' };
  }
  const body = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);

  const expected = createHmac('sha256', secret).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return { ok: false, error: 'invalid_ticket' };
  }
  // timingSafeEqual throws on length mismatch — compare lengths first
  // (length is not secret; the signature length is fixed anyway).
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, error: 'invalid_ticket' };
  }

  let payload: UploadTicketPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as UploadTicketPayload;
  } catch {
    return { ok: false, error: 'invalid_ticket' };
  }

  if (
    typeof payload !== 'object' || payload === null ||
    typeof payload.media_id !== 'string' ||
    typeof payload.code !== 'string' ||
    typeof payload.event_id !== 'string' ||
    typeof payload.storage_path !== 'string' ||
    typeof payload.mime_type !== 'string' ||
    typeof payload.max_bytes !== 'number' ||
    typeof payload.guest_name !== 'string' ||
    typeof payload.client_id !== 'string' ||
    typeof payload.captured !== 'boolean' ||
    typeof payload.exp !== 'number'
  ) {
    return { ok: false, error: 'invalid_ticket' };
  }

  if (payload.exp <= nowSeconds) {
    return { ok: false, error: 'ticket_expired' };
  }

  return { ok: true, payload };
}
