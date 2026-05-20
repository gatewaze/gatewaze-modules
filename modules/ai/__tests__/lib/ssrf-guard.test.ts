import { describe, expect, it } from 'vitest';
import { checkSsrfSafe } from '../../lib/secrets/ssrf-guard.js';

describe('checkSsrfSafe', () => {
  it('rejects non-https URIs', async () => {
    const r = await checkSsrfSafe('http://example.com/mcp');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('non_https');
  });

  it('rejects invalid URIs', async () => {
    const r = await checkSsrfSafe('not a url');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_uri');
  });

  it('rejects loopback v4 IP literal', async () => {
    const r = await checkSsrfSafe('https://127.0.0.1/mcp');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('private_ip');
  });

  it('rejects AWS metadata IP', async () => {
    const r = await checkSsrfSafe('https://169.254.169.254/mcp');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('private_ip');
  });

  it('rejects RFC1918 private v4 IPs', async () => {
    for (const ip of ['10.0.0.1', '172.16.0.1', '192.168.1.1']) {
      const r = await checkSsrfSafe(`https://${ip}/mcp`);
      expect(r.ok, `should reject ${ip}`).toBe(false);
      expect(r.reason).toBe('private_ip');
    }
  });

  it('rejects IPv6 loopback', async () => {
    const r = await checkSsrfSafe('https://[::1]/mcp');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('private_ip');
  });

  it('rejects IPv6 unique-local (fc00::/7)', async () => {
    const r = await checkSsrfSafe('https://[fc00::1]/mcp');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('private_ip');
  });

  it('rejects .local mDNS hostnames', async () => {
    const r = await checkSsrfSafe('https://my-server.local/mcp');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('mdns_hostname');
  });

  it('rejects localhost variants', async () => {
    for (const host of ['localhost', 'service.localhost']) {
      const r = await checkSsrfSafe(`https://${host}/mcp`);
      expect(r.ok, `should reject ${host}`).toBe(false);
      expect(r.reason).toBe('mdns_hostname');
    }
  });

  // Public IP literal — should pass even without DNS resolution.
  it('accepts a public IPv4 literal', async () => {
    const r = await checkSsrfSafe('https://1.1.1.1/mcp');
    expect(r.ok).toBe(true);
    expect(r.resolvedIps).toContain('1.1.1.1');
  });
});
