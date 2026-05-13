import { describe, it, expect } from 'vitest';
import {
  signWebhook,
  verifyWebhook,
  generateWebhookSecret,
  MAX_SIGNATURE_SKEW_SECONDS,
} from '../../lib/hmac.js';

describe('hmac', () => {
  describe('signWebhook', () => {
    it('produces a stable signature for the same input', () => {
      const a = signWebhook('secret', 'body', 1715000000);
      const b = signWebhook('secret', 'body', 1715000000);
      expect(a.signature).toBe(b.signature);
      expect(a.signature).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces different signatures for different bodies', () => {
      const a = signWebhook('secret', 'body-a', 1715000000);
      const b = signWebhook('secret', 'body-b', 1715000000);
      expect(a.signature).not.toBe(b.signature);
    });

    it('produces different signatures for different timestamps', () => {
      const a = signWebhook('secret', 'body', 1715000000);
      const b = signWebhook('secret', 'body', 1715000001);
      expect(a.signature).not.toBe(b.signature);
    });

    it('throws on empty secret', () => {
      expect(() => signWebhook('', 'body', 1715000000)).toThrow(/empty/i);
    });
  });

  describe('verifyWebhook', () => {
    const secret = 'k'.repeat(64);
    const altSecret = 'b'.repeat(64);
    const body = JSON.stringify({ hello: 'world' });
    const ts = 1715000000;
    const { signature } = signWebhook(secret, body, ts);

    it('verifies a valid signature against the current secret', () => {
      expect(
        verifyWebhook({
          signatureHex: signature,
          timestampSeconds: ts,
          rawBody: body,
          secrets: [secret],
          nowSeconds: ts,
        }),
      ).toBe(true);
    });

    it('verifies against the previous secret during rotation', () => {
      const { signature: sigOld } = signWebhook(altSecret, body, ts);
      expect(
        verifyWebhook({
          signatureHex: sigOld,
          timestampSeconds: ts,
          rawBody: body,
          secrets: [secret, altSecret],
          nowSeconds: ts,
        }),
      ).toBe(true);
    });

    it('rejects an expired timestamp (outside MAX_SIGNATURE_SKEW_SECONDS)', () => {
      expect(
        verifyWebhook({
          signatureHex: signature,
          timestampSeconds: ts,
          rawBody: body,
          secrets: [secret],
          nowSeconds: ts + MAX_SIGNATURE_SKEW_SECONDS + 1,
        }),
      ).toBe(false);
    });

    it('rejects a future timestamp beyond the skew window', () => {
      expect(
        verifyWebhook({
          signatureHex: signature,
          timestampSeconds: ts,
          rawBody: body,
          secrets: [secret],
          nowSeconds: ts - MAX_SIGNATURE_SKEW_SECONDS - 1,
        }),
      ).toBe(false);
    });

    it('rejects when the secret is wrong', () => {
      expect(
        verifyWebhook({
          signatureHex: signature,
          timestampSeconds: ts,
          rawBody: body,
          secrets: ['wrong'.repeat(13)],
          nowSeconds: ts,
        }),
      ).toBe(false);
    });

    it('rejects when the body has been tampered with', () => {
      expect(
        verifyWebhook({
          signatureHex: signature,
          timestampSeconds: ts,
          rawBody: body + ' ',
          secrets: [secret],
          nowSeconds: ts,
        }),
      ).toBe(false);
    });

    it('rejects malformed hex signatures', () => {
      expect(
        verifyWebhook({
          signatureHex: 'not-hex',
          timestampSeconds: ts,
          rawBody: body,
          secrets: [secret],
          nowSeconds: ts,
        }),
      ).toBe(false);
    });

    it('rejects empty signatures', () => {
      expect(
        verifyWebhook({
          signatureHex: '',
          timestampSeconds: ts,
          rawBody: body,
          secrets: [secret],
          nowSeconds: ts,
        }),
      ).toBe(false);
    });

    it('rejects empty secrets list', () => {
      expect(
        verifyWebhook({
          signatureHex: signature,
          timestampSeconds: ts,
          rawBody: body,
          secrets: [],
          nowSeconds: ts,
        }),
      ).toBe(false);
    });

    it('accepts string timestamp inputs', () => {
      expect(
        verifyWebhook({
          signatureHex: signature,
          timestampSeconds: String(ts),
          rawBody: body,
          secrets: [secret],
          nowSeconds: ts,
        }),
      ).toBe(true);
    });
  });

  describe('generateWebhookSecret', () => {
    it('returns 64-char hex', () => {
      const s = generateWebhookSecret();
      expect(s).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns a different value on every call', () => {
      const a = generateWebhookSecret();
      const b = generateWebhookSecret();
      expect(a).not.toBe(b);
    });
  });
});
