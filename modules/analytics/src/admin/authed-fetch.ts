/**
 * Authenticated fetch for the analytics admin pages.
 *
 * NOTE the filename: this must NOT be `api.ts` — the admin vite plugin
 * (vite-plugin-gatewaze-modules.ts) stubs any relative import matching
 * `./api*` as server-only, silently replacing the export with a no-op.
 *
 * /api/analytics/* is JWT-gated (requireJwt reads the Authorization
 * header) — a plain fetch({ credentials: 'include' }) carries no
 * Supabase session, so every dashboard call 401s. Attach the access
 * token per-call, same pattern as the admin app's apiKeyService /
 * moduleService.
 *
 * `@/` resolves to packages/admin/src in the host build (module admin
 * pages are bundled into the admin app by the vite plugin).
 */
import { supabase } from '@/lib/supabase';

export async function authedFetch(input: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers = new Headers(init?.headers);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}
