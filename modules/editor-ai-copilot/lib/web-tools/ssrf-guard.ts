/**
 * SSRF-safe host validation. Lifted from api/url-fetcher.ts so the
 * fetch_url tool path and the existing document URL ingestion share
 * one validator.
 *
 * Spec: spec-ai-chatbot-web-search.md §6.1
 *       spec-canvas-ai-copilot.md §0000000a (the original guard)
 */

import { lookup as dnsLookup } from 'node:dns/promises';

const PRIVATE_IPV4_RE =
  /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|0\.|255\.255\.255\.255$)/;

export function isPrivateIp(ip: string): boolean {
  if (PRIVATE_IPV4_RE.test(ip)) return true;
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  if (lower.startsWith('fe80:')) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower === '::' || lower === '::ffff:0:0') return true;
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return PRIVATE_IPV4_RE.test(v4Mapped[1]!);
  return false;
}

export type HostCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verify a hostname resolves to public IPs only. Returns ok:false
 * with a human-readable reason on rejection (caller surfaces it as a
 * tool_result error message).
 *
 * The hostname is re-resolved by the eventual fetch at connect time
 * inside gatewaze-fetch — this is the resolver-layer early-reject
 * gate, not the only line of defence.
 */
export async function assertPublicHost(hostname: string): Promise<HostCheck> {
  let resolved: { address: string }[];
  try {
    resolved = await dnsLookup(hostname, { all: true });
  } catch {
    return { ok: false, reason: `DNS lookup failed for ${hostname}` };
  }
  for (const r of resolved) {
    if (isPrivateIp(r.address)) {
      return { ok: false, reason: `host ${hostname} resolves to private IP ${r.address}` };
    }
  }
  return { ok: true };
}
