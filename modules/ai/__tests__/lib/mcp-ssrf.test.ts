/**
 * SSRF blocklist tests for MCP streamable_http connections.
 *
 * Covers both pure URL-shape validation and the DNS-resolution path
 * (mocked via dns module hijack). Per spec §7.5 — the URL-shape check
 * runs at config time; the DNS check runs per HTTP connection to
 * defend against DNS rebinding.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:dns BEFORE importing the module under test so its
// promisify(lookup) captures the mock.
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: vi.fn((host: string, _opts: unknown, cb: Function) => {
      const f = lookupFake.get(host.toLowerCase());
      if (!f) {
        cb(new Error(`ENOTFOUND ${host}`));
        return;
      }
      if (f.error) {
        cb(new Error(f.error));
        return;
      }
      cb(null, f.addresses);
    }),
  };
});

interface FakeLookup {
  addresses?: Array<{ address: string; family: 4 | 6 }>;
  error?: string;
}
const lookupFake = new Map<string, FakeLookup>();

beforeEach(() => {
  lookupFake.clear();
  delete process.env.AI_RECIPE_MCP_SSRF_RELAX;
});

afterEach(() => {
  lookupFake.clear();
  delete process.env.AI_RECIPE_MCP_SSRF_RELAX;
});

const { checkMcpUrlShape, assertHostIpsSafe } = await import('../../lib/recipes/mcp-ssrf.js');

describe('checkMcpUrlShape — scheme + parsing', () => {
  it('accepts well-formed https URL with public hostname', () => {
    expect(checkMcpUrlShape('https://mcp.example.com/v1')).toEqual({ ok: true });
  });

  it('refuses http://', () => {
    const r = checkMcpUrlShape('http://mcp.example.com/');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/non_https_scheme/);
  });

  it('refuses ftp://', () => {
    expect(checkMcpUrlShape('ftp://mcp.example.com/').ok).toBe(false);
  });

  it('refuses unparseable URL', () => {
    const r = checkMcpUrlShape('not a url');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid_url/);
  });
});

describe('checkMcpUrlShape — hostname blocklist', () => {
  it.each([
    'localhost',
    'ip6-localhost',
    'ip6-loopback',
    'metadata.google.internal',
    'metadata',
    'metadata.aws',
    'metadata.aws.internal',
    'instance-data.ec2.internal',
    'metadata.azure.com',
  ])('refuses blocked hostname %s', (host) => {
    const r = checkMcpUrlShape(`https://${host}/`);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blocked_hostname/);
  });

  it('refuses *.localhost subdomain', () => {
    const r = checkMcpUrlShape('https://anything.localhost/');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/blocked_hostname/);
  });

  it('hostname check is case-insensitive', () => {
    expect(checkMcpUrlShape('https://LOCALHOST/').ok).toBe(false);
  });
});

describe('checkMcpUrlShape — IPv4 literal ranges', () => {
  it.each([
    ['https://127.0.0.1/', 'loopback'],
    ['https://127.5.5.5/', 'loopback'],
    ['https://0.0.0.0/', 'this-network'],
    ['https://169.254.169.254/', 'AWS metadata link-local'],
    ['https://10.0.0.1/', 'RFC 1918 (default strict)'],
    ['https://172.16.0.5/', 'RFC 1918 (default strict)'],
    ['https://192.168.1.1/', 'RFC 1918 (default strict)'],
    ['https://100.64.0.1/', 'CGNAT shared'],
    ['https://239.255.255.250/', 'multicast'],
  ])('refuses %s (%s)', (url) => {
    const r = checkMcpUrlShape(url);
    expect(r.ok).toBe(false);
  });

  it('accepts a normal public IPv4 literal', () => {
    expect(checkMcpUrlShape('https://1.1.1.1/').ok).toBe(true);
  });

  it('refuses malformed IPv4 octets', () => {
    expect(checkMcpUrlShape('https://999.0.0.1/').ok).toBe(false);
  });

  it('AI_RECIPE_MCP_SSRF_RELAX allows RFC 1918 but still blocks loopback', () => {
    process.env.AI_RECIPE_MCP_SSRF_RELAX = '1';
    expect(checkMcpUrlShape('https://10.0.0.1/').ok).toBe(true);
    expect(checkMcpUrlShape('https://192.168.1.1/').ok).toBe(true);
    expect(checkMcpUrlShape('https://127.0.0.1/').ok).toBe(false);
    expect(checkMcpUrlShape('https://169.254.169.254/').ok).toBe(false);
  });
});

describe('checkMcpUrlShape — IPv6 literal ranges', () => {
  it.each(['https://[::1]/', 'https://[::]/'])(
    'refuses IPv6 loopback %s',
    (url) => {
      const r = checkMcpUrlShape(url);
      expect(r.ok).toBe(false);
    },
  );

  it('refuses unique-local fc00::/7', () => {
    const r = checkMcpUrlShape('https://[fc00::1]/');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unique_local/);
  });

  it('refuses link-local fe80::/10', () => {
    const r = checkMcpUrlShape('https://[fe80::1]/');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/link_local/);
  });

  it('allows unique-local under SSRF_RELAX', () => {
    process.env.AI_RECIPE_MCP_SSRF_RELAX = '1';
    expect(checkMcpUrlShape('https://[fc00::1]/').ok).toBe(true);
  });
});

describe('assertHostIpsSafe — DNS rebinding defence', () => {
  it('passes when DNS resolves to a public IP', async () => {
    lookupFake.set('mcp.example.com', {
      addresses: [{ address: '1.1.1.1', family: 4 }],
    });
    const r = await assertHostIpsSafe('https://mcp.example.com/');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved_ips).toEqual(['1.1.1.1']);
  });

  it('refuses when DNS resolves to loopback (rebind attack)', async () => {
    lookupFake.set('evil.example.com', {
      addresses: [{ address: '127.0.0.1', family: 4 }],
    });
    const r = await assertHostIpsSafe('https://evil.example.com/');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/blocked_v4_range/);
  });

  it('refuses when DNS resolves to AWS metadata (169.254.169.254)', async () => {
    lookupFake.set('evil.example.com', {
      addresses: [{ address: '169.254.169.254', family: 4 }],
    });
    const r = await assertHostIpsSafe('https://evil.example.com/');
    expect(r.ok).toBe(false);
  });

  it('refuses when DNS resolves to RFC 1918 (default strict)', async () => {
    lookupFake.set('evil.example.com', {
      addresses: [{ address: '10.0.0.5', family: 4 }],
    });
    const r = await assertHostIpsSafe('https://evil.example.com/');
    expect(r.ok).toBe(false);
  });

  it('refuses when ANY resolved IP is unsafe (multi-record)', async () => {
    lookupFake.set('mixed.example.com', {
      addresses: [
        { address: '1.1.1.1', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });
    const r = await assertHostIpsSafe('https://mixed.example.com/');
    expect(r.ok).toBe(false);
  });

  it('refuses when DNS resolves to IPv6 loopback', async () => {
    lookupFake.set('v6.example.com', {
      addresses: [{ address: '::1', family: 6 }],
    });
    const r = await assertHostIpsSafe('https://v6.example.com/');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/v6_loopback/);
  });

  it('refuses when DNS resolves to IPv6 unique-local', async () => {
    lookupFake.set('v6.example.com', {
      addresses: [{ address: 'fd00::1', family: 6 }],
    });
    const r = await assertHostIpsSafe('https://v6.example.com/');
    expect(r.ok).toBe(false);
  });

  it('refuses when DNS lookup fails', async () => {
    // No entry in lookupFake → ENOTFOUND
    const r = await assertHostIpsSafe('https://nowhere.example.com/');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/dns_lookup_failed/);
  });

  it('passes IPv6 public address through', async () => {
    lookupFake.set('v6.example.com', {
      addresses: [{ address: '2606:4700:4700::1111', family: 6 }],
    });
    const r = await assertHostIpsSafe('https://v6.example.com/');
    expect(r.ok).toBe(true);
  });
});
