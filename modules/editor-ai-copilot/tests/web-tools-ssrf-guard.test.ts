import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isPrivateIp, assertPublicHost } from '../lib/web-tools/ssrf-guard.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup as dnsLookup } from 'node:dns/promises';

const mockedLookup = dnsLookup as unknown as ReturnType<typeof vi.fn>;

describe('isPrivateIp', () => {
  it.each([
    ['10.0.0.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.0', false],
    ['192.168.1.1', true],
    ['127.0.0.1', true],
    ['169.254.1.1', true],
    ['0.0.0.0', true],
    ['255.255.255.255', true],
    ['8.8.8.8', false],
    ['93.184.216.34', false],
    ['::1', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['fd12::3456', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:8.8.8.8', false],
    ['2606:4700:4700::1111', false],
  ])('isPrivateIp(%s) -> %s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});

describe('assertPublicHost', () => {
  beforeEach(() => mockedLookup.mockReset());

  it('passes when all resolved addresses are public', async () => {
    mockedLookup.mockResolvedValue([{ address: '8.8.8.8' }, { address: '2606:4700:4700::1111' }]);
    const r = await assertPublicHost('example.com');
    expect(r.ok).toBe(true);
  });

  it('rejects when any resolved address is private', async () => {
    mockedLookup.mockResolvedValue([{ address: '8.8.8.8' }, { address: '10.0.0.5' }]);
    const r = await assertPublicHost('mixed.example.com');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('private IP');
  });

  it('rejects on DNS lookup failure', async () => {
    mockedLookup.mockImplementationOnce(async () => {
      throw new Error('NXDOMAIN');
    });
    const r = await assertPublicHost('nonexistent.example');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('DNS lookup failed');
  });
});
