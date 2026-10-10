import { describe, it, expect } from 'vitest';
import { isPrivateAddress, safeAvatarUrl, AVATAR_HOST_ALLOWLIST } from '../lib/import-safety';

/**
 * Regressions for the two bypasses the 2026-10-10 security review found.
 * Both were exploitable, so each keeps a named test.
 */

describe('IPv4-mapped IPv6 is not a way round the private-range check', () => {
  it('refuses the cloud metadata address in mapped form', () => {
    // net.isIP() calls these valid IPv6, and a DNS AAAA record can carry one,
    // so the v6 prefix tests alone waved them straight through.
    expect(isPrivateAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:192.168.1.1')).toBe(true);
  });

  it('refuses the hex form of a mapped address too', () => {
    // ::ffff:a9fe:a9fe is 169.254.169.254 written in hex.
    expect(isPrivateAddress('::ffff:a9fe:a9fe')).toBe(true);
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true);
  });

  it('still allows a mapped public address', () => {
    expect(isPrivateAddress('::ffff:93.184.216.34')).toBe(false);
  });
});

describe('avatar URLs are host-allowlisted, not merely https', () => {
  it('accepts an avatar from the programme host', () => {
    expect(safeAvatarUrl('https://img.sched.com/abc.jpg')).toBe('https://img.sched.com/abc.jpg');
  });

  it('refuses an arbitrary https host', () => {
    // Avatars are hot-linked, so this URL is the request every viewer's
    // browser makes — an attacker-chosen host would see all of them.
    expect(safeAvatarUrl('https://tracker.example.com/pixel.gif')).toBeNull();
    expect(safeAvatarUrl('https://sched.com.evil.com/a.jpg')).toBeNull();
  });

  it('refuses non-https and junk', () => {
    expect(safeAvatarUrl('http://img.sched.com/a.jpg')).toBeNull();
    expect(safeAvatarUrl('javascript:alert(1)')).toBeNull();
    expect(safeAvatarUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(safeAvatarUrl('')).toBeNull();
    expect(safeAvatarUrl(null)).toBeNull();
    expect(safeAvatarUrl(12345)).toBeNull();
  });

  it('caps length and strips control characters before parsing', () => {
    expect(safeAvatarUrl(`https://img.sched.com/${'a'.repeat(900)}.jpg`)).toBeNull();
    expect(safeAvatarUrl(`https://img.sched.com/a${String.fromCharCode(0)}.jpg`)).toBeTruthy();
  });

  it('uses an allowlist that does not include the whole internet', () => {
    expect(AVATAR_HOST_ALLOWLIST).not.toContain('*');
    expect(AVATAR_HOST_ALLOWLIST.length).toBeGreaterThan(0);
  });
});
