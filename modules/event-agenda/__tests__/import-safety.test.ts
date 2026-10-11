import { describe, it, expect } from 'vitest';
import { hostAllowed, isPrivateAddress, clean, LIMITS } from '../lib/import-safety';

describe('host allowlist', () => {
  it('accepts the listed hosts and any sched subdomain', () => {
    expect(hostAllowed('events.linuxfoundation.org')).toBe(true);
    expect(hostAllowed('agntconmcpconeu26.sched.com')).toBe(true);
    expect(hostAllowed('mcpseoul2026.sched.com')).toBe(true);
    expect(hostAllowed('i.ytimg.com')).toBe(true);
  });

  it('refuses lookalikes and the bare wildcard parent', () => {
    expect(hostAllowed('sched.com.evil.com')).toBe(false);
    expect(hostAllowed('evilsched.com')).toBe(false);
    expect(hostAllowed('notevents.linuxfoundation.org')).toBe(false);
    // "*.sched.com" must not match the apex itself.
    expect(hostAllowed('sched.com')).toBe(false);
    expect(hostAllowed('')).toBe(false);
  });
});

describe('private address refusal', () => {
  it('refuses loopback, private, CGNAT and link-local ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255',
                      '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
  });

  it('allows ordinary public addresses', () => {
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    // 172.32 is outside the private block.
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
  });

  it('treats a malformed address as private rather than trusting it', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
  });
});

describe('untrusted text cleaning', () => {
  it('drops tags outright rather than escaping them', () => {
    // Escaping is not enough: these values can reach attribute sinks later.
    // A tag becomes a space rather than nothing, so "a<b>c" cannot silently
    // become the single word "ac".
    expect(clean('<script>alert(1)</script>Angie', LIMITS.name)).toBe('alert(1) Angie');
    expect(clean('a<b>c', LIMITS.name)).toBe('a c');
    expect(clean('<img src=x onerror=y>', LIMITS.name)).toBeNull();
  });

  it('strips control characters and collapses whitespace', () => {
    const messy = `Angie${String.fromCharCode(0)}${String.fromCharCode(31)}   Jones\n\nVP`;
    expect(clean(messy, LIMITS.name)).toBe('Angie Jones VP');
  });

  it('caps to the field limit', () => {
    expect(clean('x'.repeat(500), LIMITS.title)?.length).toBe(LIMITS.title);
    expect(clean('x'.repeat(5000), LIMITS.bio)?.length).toBe(LIMITS.bio);
  });

  it('returns null for empty or whitespace-only input', () => {
    expect(clean('', 10)).toBeNull();
    expect(clean('   ', 10)).toBeNull();
    expect(clean(null, 10)).toBeNull();
    expect(clean(undefined, 10)).toBeNull();
  });

  it('keeps ordinary programme text intact', () => {
    expect(clean('Organizer | Platform Engineer, AAIF Community Seoul', LIMITS.role))
      .toBe('Organizer | Platform Engineer, AAIF Community Seoul');
  });
});
