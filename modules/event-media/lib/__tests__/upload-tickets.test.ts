// @ts-nocheck — vitest harness.

import { describe, it, expect } from 'vitest';
import { mintTicket, verifyTicket, TICKET_TTL_SECONDS } from '../upload-tickets.js';

const SECRET = 'test-secret-for-tickets';
const NOW = 1_800_000_000;

function payload(overrides = {}) {
  return {
    media_id: '11111111-2222-3333-4444-555555555555',
    code: 'abcdef1234',
    event_id: '99999999-8888-7777-6666-555555555555',
    storage_path: 'event/9999/1111/photo.jpg',
    mime_type: 'image/jpeg',
    max_bytes: 52_428_800,
    guest_name: 'Auntie Carol',
    client_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    captured: false,
    exp: NOW + TICKET_TTL_SECONDS,
    ...overrides,
  };
}

describe('upload tickets', () => {
  it('round-trips a payload', () => {
    const ticket = mintTicket(payload(), SECRET);
    const result = verifyTicket(ticket, NOW, SECRET);
    expect(result.ok).toBe(true);
    expect(result.payload.media_id).toBe(payload().media_id);
    expect(result.payload.guest_name).toBe('Auntie Carol');
  });

  it('rejects a tampered payload', () => {
    const ticket = mintTicket(payload(), SECRET);
    const [body, sig] = ticket.split('.');
    const tampered = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    tampered.max_bytes = 999_999_999_999; // guest tries to raise their cap
    const forged = `${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${sig}`;
    expect(verifyTicket(forged, NOW, SECRET)).toEqual({ ok: false, error: 'invalid_ticket' });
  });

  it('rejects a ticket signed with a different secret', () => {
    const ticket = mintTicket(payload(), 'some-other-secret');
    expect(verifyTicket(ticket, NOW, SECRET)).toEqual({ ok: false, error: 'invalid_ticket' });
  });

  it('rejects an expired ticket', () => {
    const ticket = mintTicket(payload({ exp: NOW - 1 }), SECRET);
    expect(verifyTicket(ticket, NOW, SECRET)).toEqual({ ok: false, error: 'ticket_expired' });
  });

  it('accepts a ticket right up to expiry and not at it', () => {
    const ticket = mintTicket(payload({ exp: NOW + 1 }), SECRET);
    expect(verifyTicket(ticket, NOW, SECRET).ok).toBe(true);
    const atExpiry = mintTicket(payload({ exp: NOW }), SECRET);
    expect(verifyTicket(atExpiry, NOW, SECRET).ok).toBe(false);
  });

  it('rejects malformed inputs without throwing', () => {
    for (const bad of [null, undefined, 42, '', 'no-dot', 'a.b.c', 'a.', '.b', 'x'.repeat(5000)]) {
      const result = verifyTicket(bad, NOW, SECRET);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a payload with missing or mistyped fields', () => {
    const bodyOf = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const signed = (obj) => {
      const { createHmac } = require('node:crypto');
      const body = bodyOf(obj);
      const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
      return `${body}.${sig}`;
    };
    expect(verifyTicket(signed({ media_id: 'x' }), NOW, SECRET).ok).toBe(false);
    expect(verifyTicket(signed(payload({ max_bytes: 'lots' })), NOW, SECRET).ok).toBe(false);
    expect(verifyTicket(signed(payload({ captured: 'yes' })), NOW, SECRET).ok).toBe(false);
  });
});
