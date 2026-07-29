/**
 * Read the operator-set residential-egress config (provider + credentials +
 * guards) from `installed_modules.config` and turn it into `ProxyCreds` the
 * providers lib can build a proxy URL from.
 *
 * This is the module-config path the platform prefers over env vars: an admin
 * picks a provider and pastes their credentials in the module's settings UI
 * (see index.ts configSchema); consumers read that here — one source of truth,
 * no per-consumer secrets.
 */

import { buildProxyUrl, newSessionId, type ProviderId, type ProxyCreds, type BuildOpts } from './providers.js';

export { buildProxyUrl, newSessionId };
export type { ProviderId, ProxyCreds, BuildOpts };

export const MODULE_ID = 'residential-egress';

/** Shape of the module's stored `installed_modules.config`. */
export interface EgressModuleConfig {
  provider?: ProviderId;
  proxy_username?: string;
  proxy_password?: string;
  gateway_host?: string;
  gateway_port?: number | string;
  zone?: string;
  default_country?: string;
  session_minutes?: number | string;
  daily_gb_cap?: number | string;
  host_allowlist?: string; // comma-separated host suffixes
}

export interface ResolvedEgress {
  configured: boolean;
  creds: ProxyCreds | null;
  hostAllowlist: string[];
  dailyGbCap: number;
}

interface SupabaseLike {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: string): { maybeSingle(): Promise<{ data: { config?: EgressModuleConfig } | null }> };
    };
  };
}

const num = (v: unknown, d: number): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? (n as number) : d;
};

/** True when a provider + credentials are present (i.e. egress can be built). */
export function isConfigured(cfg: EgressModuleConfig | null | undefined): boolean {
  return !!cfg && !!cfg.provider && cfg.provider !== 'none' && !!cfg.proxy_username && !!cfg.proxy_password;
}

/** Map the stored config to ProxyCreds (null when not configured). */
export function credsFromConfig(cfg: EgressModuleConfig | null | undefined): ProxyCreds | null {
  if (!isConfigured(cfg)) return null;
  const c = cfg as EgressModuleConfig;
  return {
    provider: c.provider as ProviderId,
    username: c.proxy_username as string,
    password: c.proxy_password as string,
    gateway_host: c.gateway_host || undefined,
    gateway_port: c.gateway_port ? num(c.gateway_port, 0) || undefined : undefined,
    zone: c.zone || undefined,
    default_country: c.default_country || undefined,
    session_minutes: c.session_minutes ? num(c.session_minutes, 10) : undefined,
  };
}

/** Comma-separated host suffixes → trimmed lowercase list. */
export function parseAllowlist(cfg: EgressModuleConfig | null | undefined): string[] {
  return (cfg?.host_allowlist ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Suffix-match a host against the allowlist (empty allowlist ⇒ allow all). */
export function hostAllowed(host: string, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  const h = host.toLowerCase();
  return allowlist.some((suf) => h === suf || h.endsWith(`.${suf}`) || h.endsWith(suf));
}

/** Load and resolve the module config from the DB. Never throws — returns a not-configured result on any error. */
export async function resolveEgress(supabase: SupabaseLike): Promise<ResolvedEgress> {
  let cfg: EgressModuleConfig | null = null;
  try {
    const { data } = await supabase.from('installed_modules').select('config').eq('id', MODULE_ID).maybeSingle();
    cfg = data?.config ?? null;
  } catch {
    cfg = null;
  }
  return {
    configured: isConfigured(cfg),
    creds: credsFromConfig(cfg),
    hostAllowlist: parseAllowlist(cfg),
    dailyGbCap: num(cfg?.daily_gb_cap, 10),
  };
}

/**
 * Convenience: a fresh proxy URL for a new exit IP. `country` overrides the
 * config default. Returns null when not configured.
 */
export function freshProxyUrl(creds: ProxyCreds | null, opts: BuildOpts = {}): { proxyUrl: string; sessionId: string } | null {
  if (!creds) return null;
  const sessionId = newSessionId();
  return { proxyUrl: buildProxyUrl(creds, { sessionId, country: opts.country ?? null }), sessionId };
}
