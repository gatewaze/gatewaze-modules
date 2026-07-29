/**
 * Module settings reader (spec §3.1).
 *
 * Reads moduleConfig from the runtime context and produces a typed
 * ModuleSettings object with defaults filled in. The platform module
 * loader gives us moduleConfig from operator overrides; values not set
 * fall back to the defaults declared in index.ts configSchema.
 */

import type { ModuleSettings } from './types.js';

const DEFAULTS: ModuleSettings = {
  enabled: true,
  default_quota_requests_per_month: 10000,
  default_quota_browser_minutes_per_month: 60,
  default_quota_proxy_gb_per_month: 5,
  instance_domain_denylist: ['localhost', '*.local', '*.internal'],
  instance_domain_allowlist: [],
  robots_cache_ttl_hours: 24,
  robots_strict_on_5xx: false,
  robots_user_agent_template:
    'GatewazeFetchBot/1.0 (+https://${GATEWAZE_INSTANCE_HOST}/fetch-bot)',
  robots_miss_rpm_per_key: 60,
  robots_origins_per_day_global: 100000,
  cost_usd_per_request: 0.0005,
  cost_usd_per_browser_second: 0.0008,
  fetch_audit_redact_query_params: [
    'token', 'key', 'apikey', 'api_key',
    'auth', 'secret', 'password', 'sig', 'signature',
  ],
  response_inline_html_max_bytes: 1_048_576,
  response_inline_markdown_max_bytes: 524_288,
  storage_bucket_screenshots: 'fetch-screenshots',
  storage_bucket_artifacts: 'fetch-artifacts',
  idempotency_ttl_seconds: 300,
  browser_seconds_reservation: 60,
  signed_url_ttl_seconds: 600,
  use_residential_egress: false,
};

/**
 * Merge operator-supplied moduleConfig over the defaults.
 */
export function resolveSettings(moduleConfig: unknown): ModuleSettings {
  if (!moduleConfig || typeof moduleConfig !== 'object') return { ...DEFAULTS };
  const cfg = moduleConfig as Partial<ModuleSettings>;
  return { ...DEFAULTS, ...cfg };
}

function envFlag(name: string): boolean | null {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return null;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * Resolve the residential-egress toggle for a single fetch
 * (spec-residential-egress-proxy §4.1 Shape A, §6.1, §11 step 6).
 *
 * Precedence (first defined wins):
 *   1. Explicit per-fetch call argument (`use_residential_egress` in the
 *      request body) — scopes the spend to the specific IP-gated target.
 *   2. Per-brand module config (`installed_modules.config.use_residential_egress`),
 *      so an admin can flip it per brand without a redeploy. Passed as the raw
 *      config value: `undefined` (key absent) falls through, a boolean wins.
 *   3. Env default (`GATEWAZE_FETCH_RESIDENTIAL_EGRESS`) for worker-only wiring.
 *   4. Off.
 *
 * A `true` result maps to `proxy: "force"` on the scrapling-fetcher `/fetch`
 * call; the service applies its residential proxy internally (credentials never
 * leave the service). The service-side per-host allowlist (§8.4,
 * SCRAPLING_EGRESS_HOST_ALLOWLIST) is the backstop — a toggle mis-set to a
 * non-allowlisted host is rejected by the service, so this side stays simple.
 */
export function resolveResidentialEgress(
  explicit: boolean | null | undefined,
  moduleConfigValue: boolean | null | undefined,
): boolean {
  if (typeof explicit === 'boolean') return explicit;
  if (typeof moduleConfigValue === 'boolean') return moduleConfigValue;
  const env = envFlag('GATEWAZE_FETCH_RESIDENTIAL_EGRESS');
  if (env != null) return env;
  return false;
}

/**
 * Build the robots-fetch user-agent string with ${GATEWAZE_INSTANCE_HOST}
 * substituted (spec §3.1, §8.3). Substitution is a one-shot replace at
 * boot — caller stores the result and reuses it for the process
 * lifetime.
 *
 * Per §3.1: env var must be a host (and optional port), no scheme.
 * We strip a leading http:// or https:// if present (defensive
 * normalization). Throws if the result still contains '://' — that
 * would otherwise produce a UA like 'https://https://...'.
 */
export function resolveUserAgent(template: string, instanceHostRaw: string): string {
  let host = instanceHostRaw.trim();
  if (host.startsWith('https://')) host = host.slice('https://'.length);
  else if (host.startsWith('http://')) host = host.slice('http://'.length);
  if (host.includes('://')) {
    throw new Error(
      `GATEWAZE_INSTANCE_HOST must be host[:port] without scheme; got "${instanceHostRaw}"`,
    );
  }
  // Strip trailing slash defensively.
  host = host.replace(/\/+$/, '');
  return template.replaceAll('${GATEWAZE_INSTANCE_HOST}', host);
}
