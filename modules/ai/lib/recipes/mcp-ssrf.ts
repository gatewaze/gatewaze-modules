/**
 * SSRF blocklist for outbound MCP streamable_http connections.
 *
 * Per spec-ai-workflows-and-skill-interop.md §7.5:
 *
 *   - URLs must be `https://`.
 *   - Hostnames in the blocklist are refused (localhost, loopback,
 *     metadata services, link-local IP ranges).
 *   - DNS re-resolution per HTTP connection — the IP we connect to
 *     must also clear the blocklist (defends against DNS rebinding
 *     during long-lived MCP sessions).
 *
 * The blocklist mirrors the one in scrapling-fetcher §8.2 — same
 * threats, same answer. We keep this module pure (no IO except the
 * dns.lookup needed for IP-level checks) so it can be unit-tested
 * against a mocked resolver.
 */

import { lookup, type LookupAddress } from 'node:dns';
import { promisify } from 'node:util';

const dnsLookup = promisify(lookup);

/** Hostnames that must NEVER be reached. Match by exact lowercase. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'metadata.google.internal',
  'metadata',                              // legacy GCP shorthand
  'metadata.aws',
  'metadata.aws.internal',
  'instance-data.ec2.internal',
  'metadata.azure.com',
  // IPv6 "localhost" sometimes presented bare.
  'ip6-loopback',
]);

/**
 * IPv4 CIDR ranges that must never be reached. Each entry is
 * [network: number, mask-bits].
 *
 * The well-known set:
 *   - 127.0.0.0/8        loopback
 *   - 0.0.0.0/8          "this network" (RFC 1122)
 *   - 10.0.0.0/8         RFC 1918 private
 *   - 169.254.0.0/16     link-local + AWS metadata
 *   - 172.16.0.0/12      RFC 1918 private
 *   - 192.168.0.0/16     RFC 1918 private
 *   - 100.64.0.0/10      shared address space (CGNAT)
 *   - 224.0.0.0/4        multicast
 *
 * The classics-plus-CGNAT set deliberately blocks RFC 1918 too — we
 * NEVER want an MCP server URL pointing into a private network from
 * a hosted Gatewaze deployment. Operators running on-prem who DO want
 * to reach private MCP endpoints set AI_RECIPE_MCP_SSRF_RELAX=1 to
 * allow RFC 1918 (still blocks loopback + metadata).
 */
const BLOCKED_V4_RANGES: Array<[number, number]> = [
  [ipv4ToInt('127.0.0.0'), 8],
  [ipv4ToInt('0.0.0.0'), 8],
  [ipv4ToInt('169.254.0.0'), 16],
  [ipv4ToInt('224.0.0.0'), 4],
];
const PRIVATE_V4_RANGES: Array<[number, number]> = [
  [ipv4ToInt('10.0.0.0'), 8],
  [ipv4ToInt('172.16.0.0'), 12],
  [ipv4ToInt('192.168.0.0'), 16],
  [ipv4ToInt('100.64.0.0'), 10],
];

export interface SsrfCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Pure URL-shape validation. Use BEFORE DNS resolution to catch
 * obvious cases (loopback hostnames, IP literals in the blocklist,
 * non-HTTPS schemes). The DNS-level check is in `assertHostIpsSafe`.
 */
export function checkMcpUrlShape(rawUrl: string): SsrfCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    return { ok: false, reason: `invalid_url: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `non_https_scheme: ${parsed.protocol}` };
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: `blocked_hostname: ${host}` };
  }
  if (host.endsWith('.localhost')) {
    return { ok: false, reason: `blocked_hostname: ${host}` };
  }
  // Bare IPv4 literal — check against ranges immediately.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const ip = ipv4ToInt(host);
    if (ip == null) return { ok: false, reason: `invalid_ipv4: ${host}` };
    const blockResult = isV4Blocked(ip);
    if (!blockResult.ok) return blockResult;
  }
  // IPv6 literal — Node URL parses [::1] as the hostname '[::1]'.
  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = host.slice(1, -1).toLowerCase();
    if (v6 === '::1' || v6 === '0:0:0:0:0:0:0:1' || v6 === '::') {
      return { ok: false, reason: `blocked_ipv6_loopback: ${host}` };
    }
    if (v6.startsWith('fc') || v6.startsWith('fd')) {
      // Unique-local (RFC 4193) — equivalent of RFC 1918 for v6.
      if (!sssrfRelaxed()) {
        return { ok: false, reason: `blocked_ipv6_unique_local: ${host}` };
      }
    }
    if (v6.startsWith('fe80')) {
      return { ok: false, reason: `blocked_ipv6_link_local: ${host}` };
    }
  }
  return { ok: true };
}

/**
 * Resolve the URL's hostname and check every resolved IP against the
 * blocklist. Call AFTER `checkMcpUrlShape` returns ok, and re-call
 * per HTTP connection (not per JSON-RPC message — sessions persist;
 * spec §7.5 explicitly defines the cadence).
 *
 * Returns the IP that actually passed the check so the caller can
 * pin the socket to it (a fully rebinding-proof implementation would
 * connect by IP and pass the original Host header).
 */
export async function assertHostIpsSafe(rawUrl: string): Promise<
  { ok: true; resolved_ips: string[] } | { ok: false; reason: string }
> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    return { ok: false, reason: `invalid_url: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Skip DNS lookup for literal IPs — checkMcpUrlShape already
  // validated them; resolve them as themselves.
  const host = parsed.hostname.toLowerCase();
  let addresses: LookupAddress[];
  try {
    addresses = await dnsLookup(host, { all: true });
  } catch (err) {
    return { ok: false, reason: `dns_lookup_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: 'dns_lookup_no_addresses' };
  }
  for (const addr of addresses) {
    if (addr.family === 4) {
      const ip = ipv4ToInt(addr.address);
      if (ip == null) {
        return { ok: false, reason: `dns_invalid_v4: ${addr.address}` };
      }
      const v = isV4Blocked(ip);
      if (!v.ok) return { ok: false, reason: v.reason ?? 'blocked_v4' };
    } else if (addr.family === 6) {
      const v6 = addr.address.toLowerCase();
      if (v6 === '::1' || v6 === '0:0:0:0:0:0:0:1' || v6 === '::') {
        return { ok: false, reason: `dns_resolved_to_v6_loopback: ${addr.address}` };
      }
      if ((v6.startsWith('fc') || v6.startsWith('fd')) && !sssrfRelaxed()) {
        return { ok: false, reason: `dns_resolved_to_v6_unique_local: ${addr.address}` };
      }
      if (v6.startsWith('fe80')) {
        return { ok: false, reason: `dns_resolved_to_v6_link_local: ${addr.address}` };
      }
    }
  }
  return { ok: true, resolved_ips: addresses.map((a) => a.address) };
}

// ─── Internals ───────────────────────────────────────────────────────

function ipv4ToInt(addr: string): number {
  const parts = addr.split('.');
  if (parts.length !== 4) return Number.NaN;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return Number.NaN;
    const n = Number(p);
    if (n < 0 || n > 255) return Number.NaN;
    out = (out << 8) | n;
  }
  // Force unsigned 32-bit.
  return out >>> 0;
}

function isV4Blocked(ip: number): SsrfCheckResult {
  for (const [net, bits] of BLOCKED_V4_RANGES) {
    if (matchesCidr(ip, net, bits)) {
      return { ok: false, reason: `blocked_v4_range: ${cidrLabel(net, bits)}` };
    }
  }
  if (!sssrfRelaxed()) {
    for (const [net, bits] of PRIVATE_V4_RANGES) {
      if (matchesCidr(ip, net, bits)) {
        return { ok: false, reason: `blocked_private_v4_range: ${cidrLabel(net, bits)}` };
      }
    }
  }
  return { ok: true };
}

function matchesCidr(ip: number, net: number, bits: number): boolean {
  if (bits === 0) return true;
  if (Number.isNaN(ip) || Number.isNaN(net)) return false;
  const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (net & mask);
}

function cidrLabel(net: number, bits: number): string {
  const a = (net >>> 24) & 0xff;
  const b = (net >>> 16) & 0xff;
  const c = (net >>> 8) & 0xff;
  const d = net & 0xff;
  return `${a}.${b}.${c}.${d}/${bits}`;
}

function sssrfRelaxed(): boolean {
  // Single-instance escape hatch — on-prem operators who deliberately
  // want recipes to reach private-network MCP endpoints can set this.
  // Loopback + metadata services stay blocked even when relaxed.
  return process.env.AI_RECIPE_MCP_SSRF_RELAX === '1';
}
