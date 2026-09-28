/**
 * Every `/api/admin/events/*` route must carry the module's own auth gate.
 *
 * Testing the middleware in isolation (require-jwt.test.ts) proves the gate
 * works; it does not prove the routes use it. The bug this repo actually
 * shipped was the second kind — five admin routes, including a destructive
 * `bulk-delete`, registered with no gate at all, protected only because the
 * newsletters and host-media modules happen to mount blanket-gated routers at
 * `/api/admin`. A sixth route added later would reintroduce exactly that.
 *
 * So this reads the registrations out of the source. Structural, not
 * behavioural — but it fails on the change that matters, which a mock-Express
 * harness around a 1000-line route file would not do any more honestly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, '..', '..', 'api.ts'), 'utf8');

/** `app.<method>('/api/admin/events/...', <rest>` → [path, rest-of-line]. */
function adminRouteRegistrations(): Array<{ path: string; rest: string }> {
  const re = /app\.(get|post|put|patch|delete)\(\s*'(\/api\/admin\/events[^']*)'\s*,([^\n]*)/g;
  const out: Array<{ path: string; rest: string }> = [];
  for (const m of source.matchAll(re)) out.push({ path: m[2], rest: m[3] });
  return out;
}

describe('/api/admin/events/* route registrations', () => {
  it('finds the admin routes at all (guards against the regex silently rotting)', () => {
    const routes = adminRouteRegistrations();
    expect(routes.length).toBeGreaterThanOrEqual(5);
    expect(routes.map((r) => r.path)).toContain('/api/admin/events/list');
    expect(routes.map((r) => r.path)).toContain('/api/admin/events/bulk-delete');
  });

  it('passes the gate middleware to every one of them', () => {
    const ungated = adminRouteRegistrations()
      .filter((r) => !/^\s*gate\s*,/.test(r.rest))
      .map((r) => r.path);
    expect(ungated).toEqual([]);
  });

  it('builds the gate from the module\'s own requireJwt', () => {
    expect(source).toMatch(/import\s*\{[^}]*requireJwt[^}]*\}\s*from\s*'\.\/lib\/require-jwt'/);
  });

  it('pairs authentication with authorization, so neither can be picked up alone', () => {
    // A valid session is not admin rights: portal members share the auth
    // project with admins, and these handlers run as service_role. Both halves
    // live in one `gate` array precisely so a new route gets both or neither.
    expect(source).toMatch(
      /const gate = \[\s*adminGate\(projectRoot\)\s*,\s*requireAdmin\(projectRoot\)\s*\]/,
    );
  });

  it('checks the admin role against an active admin_profiles row, and fails closed', () => {
    const fn = source.slice(source.indexOf('function requireAdmin('));
    expect(fn).toMatch(/from\('admin_profiles'\)/);
    expect(fn).toMatch(/\.eq\('user_id', userId\)/);
    expect(fn).toMatch(/is_active === false/);
    expect(fn).toMatch(/ADMIN_ROLES\.includes/);
    // 403 on the deny path, not a silent next().
    expect(fn).toMatch(/res\.status\(403\)/);
  });

  it('verifies untrusted tokens with a client separate from the service-role one', () => {
    // The token-verification path must not share the client instance that does
    // privileged writes, and must not persist or refresh sessions.
    expect(source).toMatch(/requireJwt\(\(\) => initVerifySupabase\(projectRoot\)/);
    const fn = source.slice(source.indexOf('function initVerifySupabase('));
    expect(fn).toMatch(/autoRefreshToken:\s*false/);
    expect(fn).toMatch(/persistSession:\s*false/);
  });
});
