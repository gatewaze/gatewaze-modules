import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkSsrfSafe } from '../../lib/secrets/ssrf-guard.js';

describe('checkSsrfSafe', () => {
  // The guard honours AI_MCP_HTTP_ALLOW_PRIVATE as a dev/staging escape hatch.
  // These cases assert the *enforcing* behaviour, so pin the override off
  // rather than inheriting whatever the runner's environment happens to set.
  const previousOverride = process.env.AI_MCP_HTTP_ALLOW_PRIVATE;

  beforeEach(() => {
    delete process.env.AI_MCP_HTTP_ALLOW_PRIVATE;
  });

  afterEach(() => {
    if (previousOverride === undefined) delete process.env.AI_MCP_HTTP_ALLOW_PRIVATE;
    else process.env.AI_MCP_HTTP_ALLOW_PRIVATE = previousOverride;
  });

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

  // The escape hatch is read per call, not captured at module load, so
  // toggling it after import takes effect (and can be scoped in tests).
  it('AI_MCP_HTTP_ALLOW_PRIVATE=true bypasses the guard, and only when set', async () => {
    expect((await checkSsrfSafe('https://127.0.0.1/mcp')).ok).toBe(false);

    process.env.AI_MCP_HTTP_ALLOW_PRIVATE = 'true';
    expect((await checkSsrfSafe('https://127.0.0.1/mcp')).ok).toBe(true);

    process.env.AI_MCP_HTTP_ALLOW_PRIVATE = 'false';
    expect((await checkSsrfSafe('https://127.0.0.1/mcp')).ok).toBe(false);
  });
});
