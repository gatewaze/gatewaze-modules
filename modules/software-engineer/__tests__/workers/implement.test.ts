// @ts-nocheck — vitest harness; the worker is @ts-nocheck'd already.
//
// Regression coverage for issue #56: implement.ts used to decide "did the agent produce work?"
// solely from `hasChanges()` (git status --porcelain). An agent that runs `git commit` itself
// leaves a clean tree with real commits ahead of the clone point, so the phase hard-failed with
// "agent produced no changes in any writable repo" and discarded the agent's work. The fix combines
// `hasChanges` with `commitsAhead` in the worker's per-repo loop and pushes without committing when
// the tree is already clean but ahead.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/git.js', () => ({
  redactToken: (msg: string) => msg,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => { throw new Error('createClient should not be called in tests'); },
}));

const gh = vi.hoisted(() => ({
  compare: vi.fn(async () => ({ files: [{ filename: 'a.ts', status: 'modified', additions: 3, deletions: 1 }] })),
  defaultBranch: vi.fn(async () => 'main'),
}));
vi.mock('../../lib/github.js', () => ({
  githubClient: () => ({ compare: gh.compare, defaultBranch: gh.defaultBranch }),
}));

const enqueue = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock('../../lib/enqueue.js', () => ({
  enqueuePhase: async (_ctx: unknown, runId: string, phase: string, data?: unknown) => {
    enqueue.calls.push({ runId, phase, data });
  },
}));

const wt = vi.hoisted(() => ({
  wsRepos: [] as any[],
  hasChanges: vi.fn(),
  commitsAhead: vi.fn(),
  commitAndPush: vi.fn(async () => {}),
  pushBranch: vi.fn(async () => {}),
}));
vi.mock('../../lib/worktree.js', () => ({
  makeMultiWorkspace: async () => ({ root: '/tmp/ws', repos: wt.wsRepos, cleanup: async () => {} }),
  hasChanges: (...args: any[]) => wt.hasChanges(...args),
  commitsAhead: (...args: any[]) => wt.commitsAhead(...args),
  commitAndPush: (...args: any[]) => wt.commitAndPush(...args),
  pushBranch: (...args: any[]) => wt.pushBranch(...args),
}));

const runAgentSession = vi.hoisted(() => vi.fn());
vi.mock('../../lib/phase-runner.js', () => ({ runAgentSession }));

vi.mock('../../lib/credentials.js', () => ({
  getProject: async () => ({
    intakeEnabled: true, githubToken: 'ghp_token', modelCred: 'cred', model: 'sonnet',
    maxCodeReposPerRun: 5, name: 'Demo Project',
  }),
  getCodeRepos: async () => ([{ repoOwner: 'acme', repoName: 'widgets', writeMode: 'writable', baseBranch: 'main' }]),
  resolveCommitIdentity: async () => ({ name: 'Bot', email: 'bot@example.com' }),
  resolveRunCredentials: async () => ({ committingPat: 'ghp_token', commentingPat: null, pullRequestPat: null, modelCred: 'cred' }),
}));

const rs = vi.hoisted(() => ({
  starts: [] as any[], ends: [] as any[], gates: [] as any[], prs: [] as any[],
}));
vi.mock('../../lib/run-state.js', () => ({
  recordPhaseStart: async (_sb: unknown, run: any, phase: string) => { rs.starts.push({ runId: run.id, phase }); },
  recordPhaseEnd: async (_sb: unknown, run: any, phase: string, status: string, summary?: string) => {
    rs.ends.push({ runId: run.id, phase, status, summary });
  },
  writeGate: async (_sb: unknown, run: any, gate: string, verdict: string, detail?: unknown) => {
    rs.gates.push({ runId: run.id, gate, verdict, detail });
  },
  blockRun: async (_sb: unknown, _run: any, phase: string, reason: string, detail: string) => {
    return { blocked: reason, detail };
  },
  upsertRunPr: async (_sb: unknown, run: any, repoOwner: string, repoName: string, patch: Record<string, unknown>) => {
    rs.prs.push({ runId: run.id, repoOwner, repoName, patch });
  },
}));

import implement from '../../workers/implement.js';

function mockSupabase() {
  const updates: any[] = [];
  const run = {
    id: 'run-1', site_id: 'site-1', project_id: 'proj-1', status: 'running',
    repo_owner: 'acme', repo_name: 'issues', issue_number: 56, branch_name: 'se/issue-56',
    tokens_input: 0, tokens_output: 0,
  };
  const from = (table: string) => {
    const b: any = {
      select() { return b; },
      update(row: any) { updates.push({ table, row }); return b; },
      eq() { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() {
        if (table === 'se_runs') return Promise.resolve({ data: run, error: null });
        if (table === 'se_artifacts') return Promise.resolve({ data: { content: 'Spec body' }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: any) { return Promise.resolve({ error: null }).then(onF); },
    };
    return b;
  };
  return { supabase: { from }, updates, run };
}

function repo(overrides: any = {}) {
  return { repoOwner: 'acme', repoName: 'widgets', dir: '/tmp/ws/widgets', writable: true, baseBranch: 'main', startSha: 'abc123', ...overrides };
}

describe('implement worker — hasChanges + commitsAhead combine', () => {
  beforeEach(() => {
    enqueue.calls.length = 0;
    rs.starts.length = 0; rs.ends.length = 0; rs.gates.length = 0; rs.prs.length = 0;
    wt.hasChanges.mockReset(); wt.commitsAhead.mockReset();
    wt.commitAndPush.mockReset().mockResolvedValue(undefined);
    wt.pushBranch.mockReset().mockResolvedValue(undefined);
    runAgentSession.mockReset().mockResolvedValue({ text: 'done', tokensInput: 10, tokensOutput: 20 });
    gh.compare.mockClear();
    wt.wsRepos = [repo()];
  });

  it('regression: clean tree but commits ahead — pushes without committing, phase passes', async () => {
    wt.hasChanges.mockResolvedValue(false);
    wt.commitsAhead.mockResolvedValue(1);

    const { supabase } = mockSupabase();
    const result = await implement({ data: { runId: 'run-1' } }, { supabase });

    expect(wt.commitAndPush).not.toHaveBeenCalled();
    expect(wt.pushBranch).toHaveBeenCalledTimes(1);
    expect(wt.pushBranch).toHaveBeenCalledWith('/tmp/ws/widgets', 'se/issue-56');
    expect(rs.prs).toEqual([{ runId: 'run-1', repoOwner: 'acme', repoName: 'widgets', patch: { branch: 'se/issue-56', state: 'open' } }]);
    expect(rs.ends.at(-1)).toMatchObject({ phase: 'implement', status: 'passed' });
    expect(result).toEqual({ ok: true, changedRepos: 1 });
  });

  it('existing dirty-tree case keeps working: commitAndPush is used, not pushBranch', async () => {
    wt.hasChanges.mockResolvedValue(true);
    wt.commitsAhead.mockResolvedValue(0);

    const { supabase } = mockSupabase();
    await implement({ data: { runId: 'run-1' } }, { supabase });

    expect(wt.commitAndPush).toHaveBeenCalledTimes(1);
    expect(wt.commitAndPush).toHaveBeenCalledWith('/tmp/ws/widgets', 'se/issue-56', 'feat: implement issue #56');
    expect(wt.pushBranch).not.toHaveBeenCalled();
  });

  it('true no-op: clean tree, no commits ahead — still fails with "no changes"', async () => {
    wt.hasChanges.mockResolvedValue(false);
    wt.commitsAhead.mockResolvedValue(0);

    const { supabase, updates } = mockSupabase();
    const result = await implement({ data: { runId: 'run-1' } }, { supabase });

    expect(result).toEqual({ failed: 'no changes' });
    expect(wt.commitAndPush).not.toHaveBeenCalled();
    expect(wt.pushBranch).not.toHaveBeenCalled();
    expect(rs.ends.at(-1)).toMatchObject({ phase: 'implement', status: 'failed', summary: 'agent produced no changes in any writable repo' });
    expect(updates.find((u) => u.table === 'se_runs')?.row).toMatchObject({ status: 'failed' });
  });

  it('multi-repo mixed: dirty, clean-but-ahead, and truly unchanged repos', async () => {
    wt.wsRepos = [
      repo({ repoName: 'dirty-repo', dir: '/tmp/ws/dirty-repo', startSha: 's1' }),
      repo({ repoName: 'ahead-repo', dir: '/tmp/ws/ahead-repo', startSha: 's2' }),
      repo({ repoName: 'unchanged-repo', dir: '/tmp/ws/unchanged-repo', startSha: 's3' }),
    ];
    wt.hasChanges.mockImplementation(async (dir: string) => dir === '/tmp/ws/dirty-repo');
    wt.commitsAhead.mockImplementation(async (dir: string) => (dir === '/tmp/ws/ahead-repo' ? 1 : 0));

    const { supabase } = mockSupabase();
    const result = await implement({ data: { runId: 'run-1' } }, { supabase });

    expect(result).toMatchObject({ ok: true, changedRepos: 2 });
    expect(rs.prs.map((p: any) => p.repoName).sort()).toEqual(['ahead-repo', 'dirty-repo']);
  });

  it('push failure on the clean-but-ahead path records an error se_run_prs row', async () => {
    wt.hasChanges.mockResolvedValue(false);
    wt.commitsAhead.mockResolvedValue(1);
    wt.pushBranch.mockRejectedValue(new Error('push rejected'));

    const { supabase } = mockSupabase();
    const result = await implement({ data: { runId: 'run-1' } }, { supabase });

    expect(result).toEqual({ ok: true, changedRepos: 1 });
    expect(rs.prs).toEqual([{ runId: 'run-1', repoOwner: 'acme', repoName: 'widgets', patch: { branch: 'se/issue-56', state: 'error', error: 'push rejected' } }]);
  });
});
