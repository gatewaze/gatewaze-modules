// @ts-nocheck — vitest harness; the worker is @ts-nocheck'd already.
//
// Regression coverage for issue #57: a per-run cost ceiling trip (`result.costCeiling === true`)
// must route through `blockRun` (status='blocked', a resumable config problem) instead of the
// worker's generic `result.error` → status='failed' dead end. An ordinary agent-session crash
// (no `costCeiling` flag) must still take the unchanged `failed` path.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const rs = vi.hoisted(() => ({
  starts: [] as any[], ends: [] as any[], blocks: [] as any[],
}));
vi.mock('../../lib/run-state.js', () => ({
  recordPhaseStart: async (_sb: unknown, run: any, phase: string) => { rs.starts.push({ runId: run.id, phase }); },
  recordPhaseEnd: async (_sb: unknown, run: any, phase: string, status: string, summary?: string) => {
    rs.ends.push({ runId: run.id, phase, status, summary });
  },
  blockRun: async (_sb: unknown, run: any, phase: string, gate: string, reason: string) => {
    rs.blocks.push({ runId: run.id, phase, gate, reason });
    return { blocked: reason };
  },
  writeGate: async () => {},
  listRunPrs: async () => [],
}));

vi.mock('../../lib/enqueue.js', () => ({ enqueuePhase: async () => {} }));

vi.mock('../../lib/worktree.js', () => ({
  makeMultiWorkspace: async () => ({ root: '/tmp/x', repos: [], cleanup: async () => {} }),
}));

vi.mock('../../lib/github.js', () => ({
  githubClient: () => ({ defaultBranch: async () => 'main', compare: async () => ({ files: [] }) }),
}));

vi.mock('../../lib/git.js', () => ({ redactToken: (msg: string) => msg }));

vi.mock('../../lib/credentials.js', () => ({
  getProject: async () => ({
    intakeEnabled: true, githubToken: 'ghp_token', modelCred: 'cred', model: 'sonnet',
  }),
  getCodeRepos: async () => [],
}));

const runAgentSession = vi.hoisted(() => vi.fn());
vi.mock('../../lib/phase-runner.js', () => ({ runAgentSession }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => { throw new Error('createClient should not be called in tests'); },
}));

import verify from '../../workers/verify.js';

function mockSupabase() {
  const updates: any[] = [];
  const run = {
    id: 'run-1', site_id: 'site-1', project_id: 'proj-1', status: 'running',
    repo_owner: 'acme', repo_name: 'issues', issue_number: 57, branch_name: 'se/issue-57',
  };
  const from = (table: string) => {
    const b: any = {
      select() { return b; },
      update(row: any) { updates.push({ table, row }); return b; },
      eq() { return b; },
      maybeSingle() {
        if (table === 'se_runs') return Promise.resolve({ data: run, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: any) { return Promise.resolve({ error: null }).then(onF); },
    };
    return b;
  };
  return { supabase: { from }, updates, run };
}

describe('verify worker cost ceiling handling (issue #57)', () => {
  beforeEach(() => {
    rs.starts.length = 0; rs.ends.length = 0; rs.blocks.length = 0;
    runAgentSession.mockReset();
  });

  it('routes a cost-ceiling trip through blockRun instead of failing the run', async () => {
    const msg = 'cost ceiling reached: this run has spent $22.55 of its $20.00 per-run ceiling — raise it in Setup or split the issue';
    runAgentSession.mockImplementation(async () => ({ error: msg, costCeiling: true }));

    const { supabase, updates } = mockSupabase();
    const result = await verify({ data: { runId: 'run-1' } }, { supabase });

    expect(result).toEqual({ blocked: msg });
    expect(rs.blocks).toEqual([{ runId: 'run-1', phase: 'verify', gate: 'cost_ceiling', reason: msg }]);
    expect(rs.ends.find((e) => e.status === 'failed')).toBeUndefined();
    expect(updates.find((u) => u.table === 'se_runs' && u.row?.status === 'failed')).toBeUndefined();
  });

  it('leaves an ordinary (non-ceiling) error on the unchanged failed path', async () => {
    runAgentSession.mockImplementation(async () => ({ error: 'agent session crashed' }));

    const { supabase, updates } = mockSupabase();
    const result = await verify({ data: { runId: 'run-1' } }, { supabase });

    expect(result).toEqual({ failed: 'agent session crashed' });
    expect(rs.blocks).toEqual([]);
    expect(rs.ends.at(-1)).toMatchObject({ phase: 'verify', status: 'failed', summary: 'agent session crashed' });
    expect(updates.find((u) => u.table === 'se_runs')?.row).toMatchObject({ status: 'failed' });
  });
});
