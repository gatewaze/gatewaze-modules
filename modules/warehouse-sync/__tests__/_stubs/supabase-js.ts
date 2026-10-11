/**
 * Stub for `@supabase/supabase-js`.
 *
 * The real package is a peerDependency (resolved by the platform at module-host
 * install time), so it is NOT present when this module's suite runs standalone
 * in CI. require-jwt.ts imports `createClient` at module scope, so the import
 * must resolve for the file to load at all. vitest.config.ts aliases the
 * package here.
 *
 * The require-jwt tests never reach a real client: they either fail before the
 * cloud branch, or run with SUPABASE_URL unset so `verifyClient()` returns null.
 */
export function createClient(): never {
  throw new Error('supabase-js stub: createClient must not be called in these tests');
}
