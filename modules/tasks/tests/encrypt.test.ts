import { describe, it, expect, beforeEach } from 'vitest';
import { encrypt, decrypt, redactUrl } from '../lib/encrypt';

describe('encrypt', () => {
  beforeEach(() => {
    process.env.TASKS_WEBHOOK_ENCRYPTION_KEY = 'a'.repeat(64); // hex
  });

  it('encrypt then decrypt round-trips', () => {
    const plain = 'https://hooks.slack.com/services/T123/B456/xyz';
    const enc = encrypt(plain);
    expect(enc).not.toBe(plain);
    expect(enc!.startsWith('v01.')).toBe(true);
    expect(decrypt(enc)).toBe(plain);
  });

  it('null in → null out', () => {
    expect(encrypt(null)).toBeNull();
    expect(decrypt(null)).toBeNull();
  });

  it('plaintext (legacy) passes through decrypt', () => {
    expect(decrypt('https://plain.example.com/x')).toBe('https://plain.example.com/x');
  });
});

describe('redactUrl', () => {
  it('redacts last path segment for slack', () => {
    const r = redactUrl('https://hooks.slack.com/services/T123/B456/xyz', 'slack');
    expect(r).toContain('****');
    expect(r).not.toContain('xyz');
  });

  it('redacts last path segment for discord', () => {
    const r = redactUrl('https://discord.com/api/webhooks/123/very-long-token', 'discord');
    expect(r).toContain('****');
    expect(r).not.toContain('very-long-token');
  });

  it('replaces long path segments for generic URLs', () => {
    const r = redactUrl('https://api.example.com/abcdefghijabcdefghijabcdefghij', 'generic');
    expect(r).toContain('****');
  });

  it('falls back to **** on parse error', () => {
    expect(redactUrl('not a url', 'generic')).toBe('****');
  });
});
