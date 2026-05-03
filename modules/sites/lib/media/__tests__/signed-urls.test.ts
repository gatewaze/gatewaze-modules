import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { MediaUrlSigner } from '../signed-urls.js';

const KEY = randomBytes(32);

describe('MediaUrlSigner', () => {
  it('throws on insufficient key length', () => {
    expect(() => new MediaUrlSigner(Buffer.from('short'))).toThrow(/at least 32/);
  });

  it('produces a signed URL containing token + exp + op + ip_cidr', () => {
    const signer = new MediaUrlSigner(KEY);
    const result = signer.sign({
      mediaId: 'm-1', storagePath: 'media/foo.jpg', op: 'read', ttlSeconds: 300,
    });
    expect(result.signedUrl).toMatch(/^\/api\/media\/serve\/m-1\?/);
    expect(result.signedUrl).toContain('token=');
    expect(result.signedUrl).toContain('exp=');
    expect(result.signedUrl).toContain('op=read');
    expect(result.signedUrl).toContain('ip_cidr=0.0.0.0%2F0');
  });

  it('returns expiry timestamp', () => {
    const signer = new MediaUrlSigner(KEY);
    const before = Math.floor(Date.now() / 1000);
    const result = signer.sign({
      mediaId: 'm-1', storagePath: 'media/foo.jpg', op: 'read', ttlSeconds: 600,
    });
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 600);
    expect(result.expiresAt).toBeLessThanOrEqual(before + 601);
  });

  it('validates a valid signature', () => {
    const signer = new MediaUrlSigner(KEY);
    const { signedUrl } = signer.sign({
      mediaId: 'm-1', storagePath: 'media/foo.jpg', op: 'read', ttlSeconds: 300,
    });
    const params = new URLSearchParams(signedUrl.split('?')[1]);
    const result = signer.validate({
      mediaId: 'm-1', storagePath: 'media/foo.jpg', params, requestIp: '10.0.0.5',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects mismatched media_id', () => {
    const signer = new MediaUrlSigner(KEY);
    const { signedUrl } = signer.sign({
      mediaId: 'm-1', storagePath: 'media/foo.jpg', op: 'read', ttlSeconds: 300,
    });
    const params = new URLSearchParams(signedUrl.split('?')[1]);
    const result = signer.validate({
      mediaId: 'm-2', storagePath: 'media/foo.jpg', params, requestIp: '10.0.0.5',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_signature');
  });

  it('rejects expired tokens', () => {
    const signer = new MediaUrlSigner(KEY);
    const { signedUrl } = signer.sign({
      mediaId: 'm-1', storagePath: 'media/foo.jpg', op: 'read', ttlSeconds: -1,
    });
    const params = new URLSearchParams(signedUrl.split('?')[1]);
    const result = signer.validate({
      mediaId: 'm-1', storagePath: 'media/foo.jpg', params, requestIp: '10.0.0.5',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('rejects request from outside ip_cidr', () => {
    const signer = new MediaUrlSigner(KEY);
    const { signedUrl } = signer.sign({
      mediaId: 'm-1', storagePath: 'media/foo.jpg', op: 'read', ttlSeconds: 300,
      ipCidr: '10.0.0.0/24',
    });
    const params = new URLSearchParams(signedUrl.split('?')[1]);
    const result = signer.validate({
      mediaId: 'm-1', storagePath: 'media/foo.jpg', params, requestIp: '192.168.1.1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ip_not_in_cidr');
  });

  it('accepts request from within ip_cidr', () => {
    const signer = new MediaUrlSigner(KEY);
    const { signedUrl } = signer.sign({
      mediaId: 'm-1', storagePath: 'media/foo.jpg', op: 'read', ttlSeconds: 300,
      ipCidr: '10.0.0.0/8',
    });
    const params = new URLSearchParams(signedUrl.split('?')[1]);
    const result = signer.validate({
      mediaId: 'm-1', storagePath: 'media/foo.jpg', params, requestIp: '10.99.99.99',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects missing token / exp / op / ip_cidr', () => {
    const signer = new MediaUrlSigner(KEY);
    const result = signer.validate({
      mediaId: 'm-1', storagePath: 'media/foo.jpg',
      params: new URLSearchParams(),
      requestIp: '10.0.0.5',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_params');
  });

  it('different signers produce non-interchangeable signatures', () => {
    const signer1 = new MediaUrlSigner(randomBytes(32));
    const signer2 = new MediaUrlSigner(randomBytes(32));
    const { signedUrl } = signer1.sign({
      mediaId: 'm-1', storagePath: 'media/foo.jpg', op: 'read', ttlSeconds: 300,
    });
    const params = new URLSearchParams(signedUrl.split('?')[1]);
    const result = signer2.validate({
      mediaId: 'm-1', storagePath: 'media/foo.jpg', params, requestIp: '10.0.0.5',
    });
    expect(result.ok).toBe(false);
  });
});
