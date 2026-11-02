/**
 * The store a Supabase bucket is served from on a brand that has moved off
 * Supabase Storage (storage module `supabase_alias`), or null when it has
 * not. The storage module is TypeScript, so it is loaded at runtime: under
 * plain node (no tsx) it cannot be, and there is no alias either. Throws
 * when the alias is set but its provider is unavailable, so nothing is
 * written to Supabase by mistake.
 */

export async function movedBucketStore(supabase, bucket) {
  let mod;
  try {
    mod = await import('../../../storage/lib/bucket-store.js');
  } catch {
    return null;
  }
  return mod.aliasedBucketStore(supabase, bucket);
}
