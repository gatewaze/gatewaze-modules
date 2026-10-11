import { describe, expect, it, vi, beforeEach } from 'vitest';

// Fake supabase: the finder returns N due editions; each refresh "takes"
// a controllable amount of fake time.
const calls: string[] = [];
let refreshMs = 0;
let now = 0;
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push(fn);
      if (fn === 'newsletter_find_editions_needing_snapshot') {
        return { data: Array.from({ length: 10 }, (_, i) => ({ edition_id: `e${i}`, data_version_ts: 't' })), error: null };
      }
      now += refreshMs;
      return { data: null, error: args['p_edition_id'] === 'e1' ? { message: 'boom' } : null };
    },
  }),
}));

describe('edition-snapshot job', () => {
  beforeEach(() => {
    calls.length = 0; now = 0;
    process.env.SUPABASE_URL = 'http://x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  it('refreshes every due edition when each is fast', async () => {
    refreshMs = 100; process.env.NEWSLETTERS_SNAPSHOT_BUDGET_MS = '60000';
    const { default: handler } = await import('../edition-snapshot.js');
    const out = await handler({} as never);
    expect(out).toMatchObject({ due: 10, refreshed: 9, errors: 1, deferred: 0 });
  });

  it('stops at the time budget and reports what it deferred, so a backlog cannot hold a worker slot', async () => {
    refreshMs = 30_000; process.env.NEWSLETTERS_SNAPSHOT_BUDGET_MS = '60000';
    const { default: handler } = await import('../edition-snapshot.js');
    const out = await handler({} as never);
    // 0s: e0 (→30s), 30s: e1 (→60s), 60s: not over budget yet → e2 (→90s), 90s: over → stop.
    expect(out).toMatchObject({ due: 10, refreshed: 2, errors: 1, deferred: 7 });
    expect(calls.filter((c) => c === 'newsletter_refresh_edition_snapshots')).toHaveLength(3);
  });
});
