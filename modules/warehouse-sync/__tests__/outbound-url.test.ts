import { describe, it, expect } from 'vitest';
import { safeOutboundUrl } from '../workers/airbyte-status';

/**
 * heartbeatUrl is operator-supplied and this worker fetches it from inside the
 * cluster while holding SUPABASE_SERVICE_ROLE_KEY, so it must not be usable as
 * an SSRF primitive. Core's config PUT merges config wholesale with no key
 * allowlist, so the value is not deploy-only.
 */
describe('safeOutboundUrl', () => {
  it('accepts a public https ping URL', () => {
    expect(safeOutboundUrl('https://hc-ping.com/abc-123')?.host).toBe('hc-ping.com');
  });

  it('rejects a scheme-less value (the likely operator typo)', () => {
    expect(safeOutboundUrl('hc-ping.com/abc-123')).toBeNull();
  });

  it('rejects plain http', () => {
    expect(safeOutboundUrl('http://hc-ping.com/abc')).toBeNull();
  });

  it.each([
    ['https://127.0.0.1/x', 'loopback'],
    ['https://10.0.0.5/x', 'private 10/8'],
    ['https://172.16.4.4/x', 'private 172.16/12'],
    ['https://192.168.1.1/x', 'private 192.168/16'],
    ['https://169.254.42.42/x', 'cloud metadata'],
    ['https://100.100.0.1/x', 'CGNAT'],
    ['https://localhost/x', 'localhost'],
    ['https://airbyte-airbyte-server-svc.gatewaze.internal/x', 'cluster internal'],
    ['https://[::1]/x', 'ipv6 loopback'],
  ])('rejects %s (%s)', (url) => {
    expect(safeOutboundUrl(url)).toBeNull();
  });

  it('rejects a non-URL', () => {
    expect(safeOutboundUrl('')).toBeNull();
  });
});
