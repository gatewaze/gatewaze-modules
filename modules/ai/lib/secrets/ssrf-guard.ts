/**
 * spec-ai-mcp-extensions.md §Security §SSRF — runtime defenses for
 * outbound HTTP to streamable_http MCP servers.
 *
 * Walks ALL resolved A/AAAA records and rejects if any lands in:
 *   - 127.0.0.0/8         loopback v4
 *   - 10.0.0.0/8          private v4
 *   - 172.16.0.0/12       private v4
 *   - 192.168.0.0/16      private v4
 *   - 169.254.0.0/16      link-local v4 (incl. AWS/GCP/Azure metadata 169.254.169.254)
 *   - ::1/128             loopback v6
 *   - fc00::/7            unique-local v6
 *   - fe80::/10           link-local v6
 *
 * .local / mDNS hostnames are rejected by pattern. SNI mismatch with
 * the URI hostname is enforced when the fetch happens. The guard
 * itself is just the DNS-rebinding-safe IP check; callers wire it
 * into the actual connect path.
 *
 * Override: AI_MCP_HTTP_ALLOW_PRIVATE=true skips ALL checks. ONLY for
 * dev / staging where the MCP server lives in the same cluster as
 * the worker.
 */

import { promises as dns } from 'node:dns';

const ALLOW_PRIVATE = process.env.AI_MCP_HTTP_ALLOW_PRIVATE === 'true';

export interface SsrfCheckResult {
  ok: boolean;
  reason?: 'private_ip' | 'loopback' | 'link_local' | 'mdns_hostname' | 'dns_resolve_failed' | 'invalid_uri' | 'non_https';
  details?: string;
}

const V4_PRIVATE_RANGES: Array<[number, number]> = [
  // [start, end] as 32-bit unsigned ints. ip2int output range.
  [ip2int('127.0.0.0'),   ip2int('127.255.255.255')],   // loopback
  [ip2int('10.0.0.0'),    ip2int('10.255.255.255')],    // private
  [ip2int('172.16.0.0'),  ip2int('172.31.255.255')],    // private
  [ip2int('192.168.0.0'), ip2int('192.168.255.255')],   // private
  [ip2int('169.254.0.0'), ip2int('169.254.255.255')],   // link-local
  [ip2int('0.0.0.0'),     ip2int('0.255.255.255')],     // "this network"
];

function ip2int(ip: string): number {
  const parts = ip.split('.');
  return ((parseInt(parts[0]!, 10) * 256 + parseInt(parts[1]!, 10)) * 256 + parseInt(parts[2]!, 10)) * 256 + parseInt(parts[3]!, 10);
}

function isV4Private(ip: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const n = ip2int(ip);
  return V4_PRIVATE_RANGES.some(([s, e]) => n >= s && n <= e);
}

function isV6Private(ip: string): boolean {
  // ::1 loopback
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true;
  const lower = ip.toLowerCase();
  // fc00::/7 unique-local (matches fc.. and fd..)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // fe80::/10 link-local (matches fe8.., fe9.., fea.., feb..)
  if (/^fe[89ab]/.test(lower)) return true;
  return false;
}

/**
 * Check a URI for SSRF risk. Resolves the hostname and ensures EVERY
 * resolved address is public. The caller MUST pin the resolved IP
 * for the actual connect — between this check and a later `fetch`,
 * DNS could be rebinding to point at private space.
 *
 * Returns the resolved IPs the caller should pin to.
 */
export async function checkSsrfSafe(uri: string): Promise<SsrfCheckResult & { resolvedIps?: string[] }> {
  if (ALLOW_PRIVATE) return { ok: true };

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { ok: false, reason: 'invalid_uri', details: uri };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'non_https', details: parsed.protocol };
  }
  const hostname = parsed.hostname;
  // mDNS / .local hostnames are always blocked — they could resolve to
  // anything on the local link.
  if (/\.local$|\.localhost$|^localhost$/.test(hostname)) {
    return { ok: false, reason: 'mdns_hostname', details: hostname };
  }

  // If the hostname IS an IP literal, check it directly.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    if (isV4Private(hostname)) {
      return { ok: false, reason: 'private_ip', details: hostname };
    }
    return { ok: true, resolvedIps: [hostname] };
  }
  if (/:/.test(hostname) || /^\[.*\]$/.test(hostname)) {
    // Node's URL.hostname keeps the brackets for IPv6 literals on
    // some versions; strip them so isV6Private matches.
    const stripped = hostname.replace(/^\[|\]$/g, '');
    if (isV6Private(stripped)) {
      return { ok: false, reason: 'private_ip', details: stripped };
    }
    return { ok: true, resolvedIps: [stripped] };
  }

  // DNS lookup with both v4 and v6 records.
  let resolved: string[] = [];
  try {
    const [v4, v6] = await Promise.all([
      dns.resolve4(hostname).catch(() => []),
      dns.resolve6(hostname).catch(() => []),
    ]);
    resolved = [...v4, ...v6];
    if (resolved.length === 0) {
      // Fall back to getaddrinfo (CNAME chains).
      const fallback = await dns.lookup(hostname, { all: true });
      resolved = fallback.map((r) => r.address);
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'dns_resolve_failed',
      details: err instanceof Error ? err.message : String(err),
    };
  }

  if (resolved.length === 0) {
    return { ok: false, reason: 'dns_resolve_failed', details: 'no A/AAAA records' };
  }

  for (const ip of resolved) {
    const blocked = ip.includes(':') ? isV6Private(ip) : isV4Private(ip);
    if (blocked) {
      return {
        ok: false,
        reason: 'private_ip',
        details: `${hostname} resolved to ${ip}; rejecting (set AI_MCP_HTTP_ALLOW_PRIVATE=true for dev)`,
      };
    }
  }

  return { ok: true, resolvedIps: resolved };
}
