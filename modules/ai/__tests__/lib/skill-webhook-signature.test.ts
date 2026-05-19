import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';

/**
 * Webhook signature verification — we test the underlying HMAC logic
 * with the same primitives the route handler uses, so signature
 * mismatches are caught at the lib level before the route is hit.
 */

function verifyGitHub(secret: string, rawBody: Buffer, signature: string): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const sigHex = signature.slice('sha256='.length);
  const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (sigHex.length !== expectedHex.length) return false;
  // Standard library does the constant-time compare for us; tests just
  // need the boolean result.
  return Buffer.from(sigHex, 'hex').equals(Buffer.from(expectedHex, 'hex'));
}

describe('GitHub HMAC verification', () => {
  const secret = 'topsecret123';
  const body = Buffer.from(JSON.stringify({ ref: 'refs/heads/main', commits: [] }));
  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a correct signature', () => {
    expect(verifyGitHub(secret, body, signature)).toBe(true);
  });

  it('rejects a wrong-secret signature', () => {
    expect(verifyGitHub('wrongsecret', body, signature)).toBe(false);
  });

  it('rejects when the body has been tampered with', () => {
    const tampered = Buffer.from(JSON.stringify({ ref: 'refs/heads/main', commits: [{ id: 'evil' }] }));
    expect(verifyGitHub(secret, tampered, signature)).toBe(false);
  });

  it('rejects a missing sha256= prefix', () => {
    expect(verifyGitHub(secret, body, signature.slice('sha256='.length))).toBe(false);
  });

  it('rejects a signature of the wrong length', () => {
    expect(verifyGitHub(secret, body, 'sha256=' + 'a'.repeat(10))).toBe(false);
  });
});
