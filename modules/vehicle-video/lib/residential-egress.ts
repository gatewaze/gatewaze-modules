/**
 * Residential-egress client (spec §12) — borrows the shared residential-egress
 * config from scrapling-fetcher by acquiring a short-lived LEASE and plugging
 * the returned proxy connection into an undici ProxyAgent dispatcher. Auto Trader
 * blocks datacentre IPs, so for the URL path egress is effectively required.
 * Nothing here ever logs or serialises `proxy_url` — it embeds provider creds.
 *
 * When SCRAPLING_FETCHER_URL is unset, acquireLease throws
 * EgressNotConfiguredError, so the consumer degrades to a direct fetch.
 */

import { ProxyAgent } from 'undici';

export interface EgressLease {
  leaseId: string;
  dispatcher: ProxyAgent;
  stickySessionId: string;
  expiresAt: number;
  byteCapBytes: number;
}

export class EgressUnavailableError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'EgressUnavailableError';
    this.status = status;
  }
}

export class EgressNotConfiguredError extends Error {
  constructor(message = 'SCRAPLING_FETCHER_URL is not set — residential egress unavailable') {
    super(message);
    this.name = 'EgressNotConfiguredError';
  }
}

export function isEgressUnavailable(err: unknown): boolean {
  return err instanceof EgressUnavailableError || err instanceof EgressNotConfiguredError;
}

export interface AcquireLeaseOptions {
  consumer: string;
  targetHost: string;
  sticky?: boolean;
  country?: string;
  ttlSeconds?: number;
  jobId?: string;
}

export interface ReportUsageInput {
  bytesIn: number;
  bytesOut: number;
  requests: number;
  final?: boolean;
}

interface LeaseUsage {
  bytesIn: number;
  bytesOut: number;
  requests: number;
}

const usageByLease = new WeakMap<EgressLease, LeaseUsage>();
const CONTROL_TIMEOUT_MS = 10_000;

function baseUrl(): string | null {
  const url = process.env.SCRAPLING_FETCHER_URL;
  return url && url.trim() ? url.replace(/\/+$/, '') : null;
}

export async function acquireLease(opts: AcquireLeaseOptions): Promise<EgressLease> {
  const base = baseUrl();
  if (!base) throw new EgressNotConfiguredError();

  const body = {
    consumer: opts.consumer,
    target_host: opts.targetHost,
    sticky: opts.sticky ?? true,
    country: opts.country ?? null,
    ...(opts.ttlSeconds != null ? { ttl_seconds: opts.ttlSeconds } : {}),
    ...(opts.jobId ? { job_id: opts.jobId } : {}),
  };

  let res: Response;
  try {
    res = await fetch(`${base}/egress/lease`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Internal-Token': process.env.SCRAPLING_INTERNAL_TOKEN ?? '',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new EgressUnavailableError(`lease request failed (network): ${(err as Error)?.message ?? 'unknown'}`);
  }
  if (!res.ok) {
    throw new EgressUnavailableError(`lease request rejected (HTTP ${res.status})`, res.status);
  }

  let json: {
    lease_id?: string;
    proxy_url?: string;
    sticky_session_id?: string;
    expires_at?: string;
    ttl_seconds?: number;
    byte_cap_bytes?: number;
  };
  try {
    json = (await res.json()) as typeof json;
  } catch (err) {
    throw new EgressUnavailableError(`lease response not JSON: ${(err as Error)?.message ?? 'parse error'}`);
  }

  const proxyUrl = json.proxy_url;
  if (!json.lease_id || !proxyUrl) {
    throw new EgressUnavailableError('lease response missing lease_id or proxy_url');
  }

  const dispatcher = new ProxyAgent(proxyUrl);
  const expiresAt = json.expires_at
    ? Date.parse(json.expires_at)
    : Date.now() + (json.ttl_seconds ?? 600) * 1000;

  const lease: EgressLease = {
    leaseId: json.lease_id,
    dispatcher,
    stickySessionId: json.sticky_session_id ?? '',
    expiresAt: Number.isNaN(expiresAt) ? Date.now() + 600_000 : expiresAt,
    byteCapBytes: json.byte_cap_bytes ?? 0,
  };
  usageByLease.set(lease, { bytesIn: 0, bytesOut: 0, requests: 0 });
  return lease;
}

export async function reportUsage(leaseId: string, u: ReportUsageInput): Promise<void> {
  try {
    const base = baseUrl();
    if (!base) return;
    await fetch(`${base}/egress/report`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Internal-Token': process.env.SCRAPLING_INTERNAL_TOKEN ?? '',
      },
      body: JSON.stringify({
        lease_id: leaseId,
        bytes_in: Math.max(0, Math.round(u.bytesIn)),
        bytes_out: Math.max(0, Math.round(u.bytesOut)),
        requests: Math.max(0, Math.round(u.requests)),
        final: u.final ?? false,
      }),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
  } catch {
    // advisory — never throw
  }
}

export function readUsage(lease: EgressLease): LeaseUsage {
  const u = usageByLease.get(lease);
  return u ? { ...u } : { bytesIn: 0, bytesOut: 0, requests: 0 };
}

/** Wrap fetch so the lease's dispatcher is attached + body bytes tallied. */
export function proxiedFetch(
  lease: EgressLease,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const usage = usageByLease.get(lease) ?? { bytesIn: 0, bytesOut: 0, requests: 0 };
    usage.requests += 1;
    usageByLease.set(lease, usage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await fetch(input as RequestInfo, { ...(init ?? {}), dispatcher: lease.dispatcher } as any);
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > 0) usage.bytesIn += len;
    return res;
  };
}
