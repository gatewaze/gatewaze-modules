/**
 * Authentication wrapper that every analyticsService call delegates to
 * before reaching out to Umami.
 *
 * Per spec-analytics-module §6 + §14.1: tenant isolation is enforced
 * here, not in Umami. Umami's own multi-tenancy is defense-in-depth.
 *
 * Returns a structured outcome — service methods bubble it up via the
 * ServiceResult discriminated union.
 */

export interface AuthSupabaseClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }>;
}

export type AuthOutcome =
  | { ok: true; websiteUuid: string | null }
  | { ok: false; reason: 'forbidden' | 'property_not_found' | 'pending_provisioning'; message: string };

/**
 * Resolve a property_id to its Umami website_uuid AFTER checking that
 * the caller can read it. Returns:
 *   ok=true  → the website_uuid (or null if still provisioning)
 *   ok=false → reason discriminator
 *
 * The two-step (auth + lookup) is one round-trip via the SQL helper:
 * `can_read_analytics_property` returns false unless the caller has
 * permission AND the property exists.
 */
export async function checkReadAccessAndResolveWebsite(
  supabase: AuthSupabaseClient,
  propertyId: string,
): Promise<AuthOutcome> {
  // can_read_analytics_property returns false for both "no perms" and
  // "no such property" — disambiguate via a follow-up lookup if needed.
  const authRes = await supabase.rpc('can_read_analytics_property', { p_property_id: propertyId });
  if (authRes.error) {
    return { ok: false, reason: 'forbidden', message: `auth check failed: ${authRes.error.message}` };
  }
  if (authRes.data !== true) {
    // Could be either reason — try to disambiguate with a metadata lookup
    // (only the property's existence; service_role only). If the row
    // doesn't exist, return property_not_found; otherwise forbidden.
    const meta = await supabase.rpc('analytics_property_exists', { p_property_id: propertyId });
    if (meta.data === false) {
      return { ok: false, reason: 'property_not_found', message: `property ${propertyId} not found` };
    }
    return { ok: false, reason: 'forbidden', message: `forbidden on property ${propertyId}` };
  }

  // Auth passed — fetch the website_uuid.
  const meta = await supabase.rpc('analytics_property_meta', { p_property_id: propertyId });
  if (meta.error) {
    return { ok: false, reason: 'forbidden', message: `meta lookup failed: ${meta.error.message}` };
  }
  const data = meta.data as { website_uuid: string | null; status: string } | null;
  if (!data) {
    return { ok: false, reason: 'property_not_found', message: `property ${propertyId} not found` };
  }
  if (data.status !== 'active' || !data.website_uuid) {
    return { ok: false, reason: 'pending_provisioning', message: `property ${propertyId} is ${data.status}` };
  }
  return { ok: true, websiteUuid: data.website_uuid };
}
