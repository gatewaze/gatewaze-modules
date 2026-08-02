// @ts-nocheck — vitest harness; the lib modules are @ts-nocheck'd already.
//
// Exercises the shared merge loop (issue #17). It merges only PRs GitHub reports mergeable_state
// 'clean'; a not-clean PR is HELD (left open); a 'behind' PR is self-healed via update-branch before
// holding; an already-merged PR is recorded merged; and a thrown merge (branch protection / race) is
// held with a redacted reason. A non-bypass token means a red PR can't be forced.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable GitHub client. `prs[number].mergeable_state` drives each PR; merge/update calls are recorded.
const hub = vi.hoisted(() => ({ prs: {} as Record<number, any>, merged: [] as number[], updated: [] as number[], mergeThrows: null as any }));
vi.mock('../github.js', () => ({
  githubClient: () => ({
    getPullRequest: async (_o: string, _n: string, num: number) => hub.prs[num] ?? {},
    mergePullRequest: async (_o: string, _n: string, num: number) => {
      if (hub.mergeThrows) throw new Error(hub.mergeThrows);
      hub.merged.push(num);
      return { merged: true };
    },
    updateBranch: async (_o: string, _n: string, num: number) => { hub.updated.push(num); return {}; },
  }),
}));

import { mergeRunPrs } from '../merge-prs.js';

// Supabase double for listRunPrs (returns `rows`) + upsertRunPr (records the patch per repo).
function mockSupabase(rows: any[]) {
  const upserts: any[] = [];
  const from = () => {
    const b: any = {
      select() { return b; },
      eq() { return b; },
      order() { return Promise.resolve({ data: rows, error: null }); },
      upsert(row: unknown) { upserts.push(row); return Promise.resolve({ data: null, error: null }); },
    };
    return b;
  };
  return { from, __upserts: upserts };
}

const RUN = { id: 'run-1', site_id: 'site-1' };
const PROJECT = { githubToken: 'ghp_secrettoken' };
const pr = (n: number, extra: any = {}) => ({ repo_owner: 'acme', repo_name: 'app', pr_number: n, state: 'open', pr_url: `u${n}`, ...extra });

describe('mergeRunPrs', () => {
  beforeEach(() => { hub.prs = {}; hub.merged = []; hub.updated = []; hub.mergeThrows = null; });

  it('merges a clean PR and records it merged', async () => {
    hub.prs[10] = { mergeable_state: 'clean' };
    const supa = mockSupabase([pr(10)]);
    const r = await mergeRunPrs(supa, RUN, PROJECT);
    expect(hub.merged).toEqual([10]);
    expect(r).toMatchObject({ merged: 1, held: 0 });
    expect(r.results).toEqual([{ repo: 'acme/app', pr_number: 10, outcome: 'merged' }]);
    expect(supa.__upserts).toEqual([expect.objectContaining({ run_id: 'run-1', repo_owner: 'acme', repo_name: 'app', state: 'merged' })]);
  });

  it('holds a not-clean (blocked) PR without merging it', async () => {
    hub.prs[11] = { mergeable_state: 'blocked' };
    const supa = mockSupabase([pr(11)]);
    const r = await mergeRunPrs(supa, RUN, PROJECT);
    expect(hub.merged).toEqual([]);
    expect(r).toMatchObject({ merged: 0, held: 1 });
    expect(r.results[0]).toEqual({ repo: 'acme/app', pr_number: 11, outcome: 'held', reason: 'blocked' });
    expect(supa.__upserts).toEqual([]);
  });

  it("self-heals a 'behind' PR via update-branch, then holds it", async () => {
    hub.prs[12] = { mergeable_state: 'behind' };
    const supa = mockSupabase([pr(12)]);
    const r = await mergeRunPrs(supa, RUN, PROJECT);
    expect(hub.updated).toEqual([12]);
    expect(hub.merged).toEqual([]);
    expect(r).toMatchObject({ merged: 0, held: 1 });
    expect(r.results[0]).toMatchObject({ outcome: 'held', reason: 'behind' });
  });

  it('records an already-merged PR as merged (already_merged) without re-merging', async () => {
    hub.prs[13] = { merged: true, mergeable_state: 'clean' };
    const supa = mockSupabase([pr(13)]);
    const r = await mergeRunPrs(supa, RUN, PROJECT);
    expect(hub.merged).toEqual([]);   // no second merge call
    expect(r).toMatchObject({ merged: 1, held: 0 });
    expect(r.results[0]).toEqual({ repo: 'acme/app', pr_number: 13, outcome: 'already_merged' });
  });

  it('holds a PR when the merge call throws, and redacts the token from the reason', async () => {
    hub.prs[14] = { mergeable_state: 'clean' };
    hub.mergeThrows = 'boom ghp_secrettoken leaked';
    const supa = mockSupabase([pr(14)]);
    const r = await mergeRunPrs(supa, RUN, PROJECT);
    expect(r).toMatchObject({ merged: 0, held: 1 });
    expect(r.results[0].outcome).toBe('held');
    expect(r.results[0].reason).not.toContain('ghp_secrettoken');
  });

  it('ignores non-open / numberless PR rows', async () => {
    hub.prs[15] = { mergeable_state: 'clean' };
    const supa = mockSupabase([pr(15, { state: 'merged' }), { repo_owner: 'a', repo_name: 'b', pr_number: null, state: 'open' }]);
    const r = await mergeRunPrs(supa, RUN, PROJECT);
    expect(hub.merged).toEqual([]);
    expect(r).toEqual({ merged: 0, held: 0, results: [] });
  });

  it('merges the clean PR and holds the not-clean one in a multi-repo run', async () => {
    hub.prs[20] = { mergeable_state: 'clean' };
    hub.prs[21] = { mergeable_state: 'unstable' };
    const supa = mockSupabase([
      { repo_owner: 'acme', repo_name: 'web', pr_number: 20, state: 'open' },
      { repo_owner: 'acme', repo_name: 'api', pr_number: 21, state: 'open' },
    ]);
    const r = await mergeRunPrs(supa, RUN, PROJECT);
    expect(hub.merged).toEqual([20]);
    expect(r).toMatchObject({ merged: 1, held: 1 });
    expect(r.results).toEqual([
      { repo: 'acme/web', pr_number: 20, outcome: 'merged' },
      { repo: 'acme/api', pr_number: 21, outcome: 'held', reason: 'unstable' },
    ]);
  });
});
