/**
 * The upload tickets (lib/upload-tickets.ts).
 *
 * The ticket is the only thing standing between a third-party editor's browser
 * and an unauthorised write, because the `complete` call arrives carrying
 * whatever the client chose to send. So the forgery cases are the point of
 * this file, not the happy path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mintTicket, verifyTicket, ticketsAvailable, TICKET_TTL_SECONDS } from '../lib/upload-tickets.js';

const payload = {
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000001',
  session_id: 'bbbbbbbb-0000-4000-8000-000000000002',
  storage_bucket: 'video-masters',
  storage_path: 'agenda_entry/x/y/talk.mp4',
  mime_type: 'video/mp4',
  max_bytes: 1024,
  user_id: 'cccccccc-0000-4000-8000-000000000003',
};

const NAMES = ['SUPABASE_JWT_SECRET', 'JWT_SECRET'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const n of NAMES) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
  process.env.SUPABASE_JWT_SECRET = 'a-test-signing-secret';
});

afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

describe('round trip', () => {
  it('mints and verifies', () => {
    const t = mintTicket(payload);
    const v = verifyTicket(t);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.payload.asset_id).toBe(payload.asset_id);
      expect(v.payload.storage_path).toBe(payload.storage_path);
      expect(v.payload.max_bytes).toBe(1024);
      expect(v.payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    }
  });

  it('sets the expiry from the TTL', () => {
    const now = 1_760_000_000_000;
    const v = verifyTicket(mintTicket(payload, now), now);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.payload.exp).toBe(Math.floor(now / 1000) + TICKET_TTL_SECONDS);
  });
});

describe('forgery', () => {
  it('rejects a tampered payload', () => {
    const t = mintTicket(payload);
    const [body, sig] = t.split('.');
    // Re-encode the payload with a larger cap, keeping the original signature.
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), max_bytes: 1e12 }),
    ).toString('base64url');
    const v = verifyTicket(`${forged}.${sig}`);
    expect(v).toEqual({ ok: false, error: 'bad_signature' });
  });

  it('rejects a ticket signed with a different secret', () => {
    const t = mintTicket(payload);
    process.env.SUPABASE_JWT_SECRET = 'a-different-secret';
    expect(verifyTicket(t)).toEqual({ ok: false, error: 'bad_signature' });
  });

  it('rejects an unsigned or truncated ticket', () => {
    expect(verifyTicket('').ok).toBe(false);
    expect(verifyTicket('justbody').ok).toBe(false);
    expect(verifyTicket('body.').ok).toBe(false);
    expect(verifyTicket('.sig').ok).toBe(false);
  });

  it('rejects a ticket with more than one separator', () => {
    const t = mintTicket(payload);
    expect(verifyTicket(`${t}.extra`)).toEqual({ ok: false, error: 'malformed' });
  });

  it('rejects an absurdly long value rather than hashing it', () => {
    expect(verifyTicket('a'.repeat(5000))).toEqual({ ok: false, error: 'malformed' });
  });

  it('rejects a non-string', () => {
    expect(verifyTicket(null).ok).toBe(false);
    expect(verifyTicket(42).ok).toBe(false);
    expect(verifyTicket({ asset_id: 'x' }).ok).toBe(false);
  });
});

describe('expiry', () => {
  it('rejects an expired ticket', () => {
    const now = 1_760_000_000_000;
    const t = mintTicket(payload, now);
    const later = now + (TICKET_TTL_SECONDS + 1) * 1000;
    expect(verifyTicket(t, later)).toEqual({ ok: false, error: 'expired' });
  });

  it('still accepts one a second before expiry', () => {
    const now = 1_760_000_000_000;
    const t = mintTicket(payload, now);
    expect(verifyTicket(t, now + (TICKET_TTL_SECONDS - 1) * 1000).ok).toBe(true);
  });
});

describe('required fields', () => {
  it('rejects a payload missing a string field, even correctly signed', () => {
    // Sign a payload that omits storage_path, the way a future refactor might.
    const partial = { ...payload } as Record<string, unknown>;
    delete partial.storage_path;
    const t = mintTicket(partial as never);
    expect(verifyTicket(t)).toEqual({ ok: false, error: 'malformed' });
  });

  it('rejects a non-positive max_bytes', () => {
    const t = mintTicket({ ...payload, max_bytes: 0 });
    expect(verifyTicket(t)).toEqual({ ok: false, error: 'malformed' });
  });
});

describe('no secret configured', () => {
  it('cannot mint, and says so rather than producing an unsigned ticket', () => {
    for (const n of NAMES) delete process.env[n];
    expect(ticketsAvailable()).toBe(false);
    expect(() => mintTicket(payload)).toThrow(/SUPABASE_JWT_SECRET/);
  });

  it('refuses to verify rather than accepting anything', () => {
    const t = mintTicket(payload);
    for (const n of NAMES) delete process.env[n];
    expect(verifyTicket(t)).toEqual({ ok: false, error: 'unavailable' });
  });
});

describe('domain separation', () => {
  it('derives a subkey, so the raw JWT secret is not the signing key', () => {
    // A ticket signed with the root secret directly must not verify. This is
    // what stops a ticket from another subsystem being replayed here.
    const t = mintTicket(payload);
    const [body] = t.split('.');
    const { createHmac } = require('crypto') as typeof import('crypto');
    const rootSig = createHmac('sha256', 'a-test-signing-secret').update(body).digest('base64url');
    expect(verifyTicket(`${body}.${rootSig}`)).toEqual({ ok: false, error: 'bad_signature' });
  });
});

describe('the secret fallback the real environments depend on', () => {
  it('uses JWT_SECRET when SUPABASE_JWT_SECRET is absent', () => {
    // Neither AAIF prod nor the local stack sets SUPABASE_JWT_SECRET. Without
    // this fallback, mint returns 503 and uploads are unavailable everywhere.
    delete process.env.SUPABASE_JWT_SECRET;
    process.env.JWT_SECRET = 'the-platform-jwt-secret';
    expect(ticketsAvailable()).toBe(true);
    const t = mintTicket(payload);
    expect(verifyTicket(t).ok).toBe(true);
  });

  it('prefers SUPABASE_JWT_SECRET when both are present', () => {
    process.env.SUPABASE_JWT_SECRET = 'preferred';
    process.env.JWT_SECRET = 'fallback';
    const t = mintTicket(payload);
    // Removing the preferred one must invalidate it, proving which was used.
    delete process.env.SUPABASE_JWT_SECRET;
    expect(verifyTicket(t)).toEqual({ ok: false, error: 'bad_signature' });
  });
});
