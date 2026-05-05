/**
 * Sites-module feature flags. Reads from `platform_settings` (the same
 * key/value table used by `tenancy_v2_enforced`).
 *
 * Per spec-sites-theme-kinds §16.1 the Next.js theme path lands behind
 * `sites_theme_kinds_enabled` (default false) and operators flip it on
 * per-environment after verifying migrations + observability + publisher
 * credentials.
 *
 * Three call sites consume the flag:
 *   - sitesService.createSite/updateSite — refuse theme_kind='nextjs' input
 *   - publish-jobs createPublishJob       — refuse jobs against nextjs sites
 *   - admin publisher:validate            — refuse Git URL probes
 *
 * Each returns a 400 envelope with `code='theme_kinds_disabled'` so the UI
 * can surface a "this feature is disabled in your environment" message.
 *
 * Caching: 30s TTL — short enough that operators flipping the flag see
 * effects within a half-minute, long enough to avoid hammering
 * platform_settings on every admin write.
 */

/** Minimal structural Supabase shape — works with both the admin browser
 *  client (Supabase JS) and the API server's narrow query interface. */
export interface FlagsSupabaseClient {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): {
        maybeSingle<T = { value: string | null }>(): Promise<{
          data: T | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
}

interface CacheEntry {
  value: boolean;
  fetchedAt: number;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

/**
 * Returns true iff `sites_theme_kinds_enabled` in platform_settings is the
 * literal string 'true'. Any other value (including missing rows, malformed
 * JSON, fetch errors) is treated as false — fail closed.
 */
export async function isSitesThemeKindsEnabled(
  supabase: FlagsSupabaseClient,
  options: { skipCache?: boolean } = {},
): Promise<boolean> {
  const cached = cache.get('sites_theme_kinds_enabled');
  const now = Date.now();
  if (!options.skipCache && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  const { data, error } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'sites_theme_kinds_enabled')
    .maybeSingle();

  // Fail closed on any error — the flag protects feature access during a
  // staged rollout, so erring on the side of "disabled" is the safe call.
  if (error || !data) {
    cache.set('sites_theme_kinds_enabled', { value: false, fetchedAt: now });
    return false;
  }

  // platform_settings.value is text; treat 'true' (case-insensitive) as
  // enabled, everything else as disabled.
  const raw = (data.value ?? '').toString().trim().toLowerCase();
  const enabled = raw === 'true';
  cache.set('sites_theme_kinds_enabled', { value: enabled, fetchedAt: now });
  return enabled;
}

/** Test/admin escape hatch: clears the in-memory cache so the next call
 *  re-reads from the database. Used by tests + an admin "refresh flags"
 *  button (when one lands). */
export function clearFeatureFlagCache(): void {
  cache.clear();
}

/** Standard error envelope returned by API handlers when the flag is off
 *  and the caller tried to do something Next.js-specific. */
export const THEME_KINDS_DISABLED_ERROR = {
  code: 'theme_kinds_disabled' as const,
  message:
    'The Next.js theme path is disabled in this environment. An operator must set platform_settings.sites_theme_kinds_enabled = true to enable it.',
} as const;
