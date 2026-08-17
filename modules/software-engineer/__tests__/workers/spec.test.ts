// @ts-nocheck — vitest harness; the worker is @ts-nocheck'd already.
//
// Regression coverage for issue #53: the spec worker used to store the agent's closing CHAT
// message (`result.text`) as the `kind=spec` artifact that review/implement trust verbatim. An
// agent that chats a summary instead of writing a file silently produced a bogus spec. The fix
// makes the agent write ./specs/issue-<n>.md at the workspace root and has the worker read that
// file back — failing loud if it's missing or under the length floor — instead of trusting chat.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gh = vi.hoisted(() => ({
  putFileCalls: [] as any[],
  setStatusLabelCalls: [] as any[],
  removeLabelCalls: [] as any[],
  issue: { title: 'Fix the widget', body: 'The widget is broken.', labels: [] as string[] },
  // Keyed by issue number: the dependency issue's own getIssue result (state only matters for #9).
  depIssue: { state: 'open' },
}));
vi.mock('../../lib/github.js', () => ({
  githubClient: () => ({
    getIssue: async (_o: string, _n: string, num: number) => (num === 53 ? gh.issue : gh.depIssue),
    putFile: async (...args: any[]) => { gh.putFileCalls.push(args); },
    setStatusLabel: async (...args: any[]) => { gh.setStatusLabelCalls.push(args); },
    removeLabel: async (...args: any[]) => { gh.removeLabelCalls.push(args); },
    addLabels: async () => {},
    postComment: async () => {},
  }),
}));

const rs = vi.hoisted(() => ({
  starts: [] as any[], ends: [] as any[], blocks: [] as any[],
}));
vi.mock('../../lib/run-state.js', () => ({
  recordPhaseStart: async (_sb: unknown, run: any, phase: string) => { rs.starts.push({ runId: run.id, phase }); },
  recordPhaseEnd: async (_sb: unknown, run: any, phase: string, status: string, summary?: string) => {
    rs.ends.push({ runId: run.id, phase, status, summary });
  },
  blockRun: async (_sb: unknown, _run: any, phase: string, reason: string, detail: string) => {
    rs.blocks.push({ phase, reason, detail });
    return { blocked: reason, detail };
  },
}));

const enqueue = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock('../../lib/enqueue.js', () => ({
  enqueuePhase: async (_ctx: unknown, runId: string, phase: string, data?: unknown) => {
    enqueue.calls.push({ runId, phase, data });
  },
}));

const memory = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock('../../lib/memory.js', () => ({
  writeSpecMemory: async (...args: any[]) => { memory.calls.push(args); },
}));

vi.mock('../../lib/git.js', () => ({
  redactToken: (msg: string) => msg,
}));

// Not installed in this workspace and never actually invoked — the worker's `sb()` helper prefers
// ctx.supabase (always provided by the tests below), but the module-level import must still resolve.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => { throw new Error('createClient should not be called in tests'); },
}));

// The workspace root is a REAL temp directory (not mocked) so the worker's own node:fs
// existsSync/readFileSync calls exercise real file I/O, exactly like the agent's Write tool would.
let wsRoot = '';
vi.mock('../../lib/worktree.js', () => ({
  makeMultiWorkspace: async () => ({ root: wsRoot, repos: [], cleanup: async () => {} }),
}));

const runAgentSession = vi.hoisted(() => vi.fn());
vi.mock('../../lib/phase-runner.js', () => ({ runAgentSession }));

vi.mock('../../lib/credentials.js', () => ({
  getProject: async () => ({
    intakeEnabled: true, githubToken: 'ghp_token', modelCred: 'cred', model: 'sonnet',
    maxCodeReposPerRun: 5, name: 'Demo Project',
  }),
  getCodeRepos: async () => ([{ repoOwner: 'acme', repoName: 'widgets', baseBranch: 'main' }]),
}));

import spec from '../../workers/spec.js';

function mockSupabase() {
  const inserts: any[] = [];
  const updates: any[] = [];
  const run = {
    id: 'run-1', site_id: 'site-1', project_id: 'proj-1', status: 'running',
    repo_owner: 'acme', repo_name: 'issues', issue_number: 53, branch_name: null,
    tokens_input: 0, tokens_output: 0,
  };
  const from = (table: string) => {
    const b: any = {
      select() { return b; },
      insert(row: any) { inserts.push({ table, row }); return { then: (f: any) => f({ error: null }) }; },
      update(row: any) { updates.push({ table, row }); return b; },
      eq() { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() {
        if (table === 'se_runs') return Promise.resolve({ data: run, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: any) { return Promise.resolve({ error: null }).then(onF); },
    };
    return b;
  };
  return { supabase: { from }, inserts, updates, run };
}

describe('spec worker', () => {
  beforeEach(async () => {
    wsRoot = await mkdtemp(join(tmpdir(), 'se-ws-spec-test-'));
    gh.putFileCalls.length = 0;
    gh.setStatusLabelCalls.length = 0;
    gh.removeLabelCalls.length = 0;
    gh.issue = { title: 'Fix the widget', body: 'The widget is broken.', labels: [] };
    gh.depIssue = { state: 'open' };
    rs.starts.length = 0; rs.ends.length = 0; rs.blocks.length = 0;
    enqueue.calls.length = 0;
    memory.calls.length = 0;
    runAgentSession.mockReset();
  });
  afterEach(async () => {
    await rm(wsRoot, { recursive: true, force: true });
  });

  it('reads the agent-written spec file as the artifact, not the chat reply', async () => {
    const specBody = '# Spec\n\nGoal: fix the widget.\n' + 'Detail line.\n'.repeat(20);
    runAgentSession.mockImplementation(async (_sb: unknown, _ctx: unknown, _run: any, _project: any, _phase: string, opts: any) => {
      await mkdir(join(opts.cwd, 'specs'), { recursive: true });
      await writeFile(join(opts.cwd, 'specs/issue-53.md'), specBody, 'utf8');
      return { text: 'Done! I wrote up a spec.', tokensInput: 10, tokensOutput: 20 };
    });

    const { supabase, inserts, updates } = mockSupabase();
    const result = await spec({ data: { runId: 'run-1' } }, { supabase });

    expect(result).toEqual({ ok: true, branch: expect.any(String) });
    const specArtifact = inserts.find((i) => i.table === 'se_artifacts' && i.row.kind === 'spec');
    expect(specArtifact?.row.content).toBe(specBody);
    expect(specArtifact?.row.content).not.toContain('Done! I wrote up a spec.');

    const summaryArtifact = inserts.find((i) => i.table === 'se_artifacts' && i.row.kind === 'spec_summary');
    expect(summaryArtifact?.row.content).toBe('Done! I wrote up a spec.');

    expect(rs.ends.at(-1)).toMatchObject({ phase: 'spec', status: 'passed' });
    expect(enqueue.calls).toEqual([{ runId: 'run-1', phase: 'review', data: undefined }]);
    expect(gh.putFileCalls[0]?.[2]).toBe('specs/issue-53.md');
  });

  it('fails loud when the agent never writes the spec file (chats a summary instead)', async () => {
    // Regression case modeled on the #51 evidence: a long, plausible-sounding chat reply with no file.
    const chatOnly = 'I explored the repo and drafted a spec covering the widget fix, test plan, and risks.';
    runAgentSession.mockImplementation(async () => ({ text: chatOnly, tokensInput: 5, tokensOutput: 5 }));

    const { supabase, inserts, updates } = mockSupabase();
    const result = await spec({ data: { runId: 'run-1' } }, { supabase });

    expect(result).toEqual({ failed: 'agent did not write the spec file' });
    expect(inserts.find((i) => i.table === 'se_artifacts')).toBeUndefined();
    expect(rs.ends.at(-1)).toMatchObject({ phase: 'spec', status: 'failed', summary: 'agent did not write the spec file' });
    expect(updates.find((u) => u.table === 'se_runs')?.row).toMatchObject({ status: 'failed' });
    expect(enqueue.calls).toEqual([]);
  });

  it('fails loud when the spec file exists but is a stub under the length floor', async () => {
    runAgentSession.mockImplementation(async (_sb: unknown, _ctx: unknown, _run: any, _project: any, _phase: string, opts: any) => {
      await mkdir(join(opts.cwd, 'specs'), { recursive: true });
      await writeFile(join(opts.cwd, 'specs/issue-53.md'), 'TODO', 'utf8');
      return { text: 'placeholder', tokensInput: 1, tokensOutput: 1 };
    });

    const { supabase, inserts } = mockSupabase();
    const result = await spec({ data: { runId: 'run-1' } }, { supabase });

    expect(result).toEqual({ failed: 'agent did not write the spec file' });
    expect(inserts.find((i) => i.table === 'se_artifacts')).toBeUndefined();
  });

  it('surfaces a runAgentSession error without touching the spec file', async () => {
    runAgentSession.mockImplementation(async () => ({ error: 'agent session crashed' }));

    const { supabase, inserts, updates } = mockSupabase();
    const result = await spec({ data: { runId: 'run-1' } }, { supabase });

    expect(result).toEqual({ failed: 'agent session crashed' });
    expect(inserts.find((i) => i.table === 'se_artifacts')).toBeUndefined();
    expect(updates.find((u) => u.table === 'se_runs')?.row).toMatchObject({ status: 'failed' });
  });

  it('parks the run at spec start when a dependency is still unmet (issue #59)', async () => {
    gh.issue = { title: 'Fix the widget', body: 'Depends on #9\n\nThe widget is broken.', labels: [] };
    gh.depIssue = { state: 'open' };
    runAgentSession.mockImplementation(async () => { throw new Error('should not run — parked before workspace/agent spend'); });

    const { supabase, updates } = mockSupabase();
    const result = await spec({ data: { runId: 'run-1' } }, { supabase });

    expect(result).toEqual({ parked: [9] });
    expect(rs.ends.at(-1)).toMatchObject({ phase: 'spec', status: 'skipped', summary: expect.stringContaining('#9') });
    expect(updates.find((u) => u.table === 'se_runs')?.row).toMatchObject({ status: 'cancelled', error: null });
    expect(gh.setStatusLabelCalls).toEqual([['acme', 'issues', 53, null]]);
    expect(gh.removeLabelCalls.length).toBeGreaterThan(0);
    expect(runAgentSession).not.toHaveBeenCalled();
  });

  it('proceeds past the dependency check when there are no unmet dependencies (unaffected happy path)', async () => {
    gh.issue = { title: 'Fix the widget', body: 'Depends on #9\n\nThe widget is broken.', labels: [] };
    gh.depIssue = { state: 'closed' };
    const specBody = '# Spec\n\nGoal: fix the widget.\n' + 'Detail line.\n'.repeat(20);
    runAgentSession.mockImplementation(async (_sb: unknown, _ctx: unknown, _run: any, _project: any, _phase: string, opts: any) => {
      await mkdir(join(opts.cwd, 'specs'), { recursive: true });
      await writeFile(join(opts.cwd, 'specs/issue-53.md'), specBody, 'utf8');
      return { text: 'Done!', tokensInput: 10, tokensOutput: 20 };
    });

    const { supabase } = mockSupabase();
    const result = await spec({ data: { runId: 'run-1' } }, { supabase });

    expect(result).toEqual({ ok: true, branch: expect.any(String) });
    expect(rs.ends.at(-1)).toMatchObject({ phase: 'spec', status: 'passed' });
  });
});
