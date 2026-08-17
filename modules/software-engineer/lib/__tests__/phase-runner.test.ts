// @ts-nocheck — vitest harness; lib modules are @ts-nocheck'd already.
//
// Pins the two cost-attribution fixes (issue #55) inside runAgentSession's heartbeat:
//   - the resolved model/engine is written onto the running se_phases row right after
//     resolvePhaseModel() resolves, before the heartbeat's first tick — otherwise the run-header
//     cost aggregation attributes the live estimate to 'unattributed'.
//   - each heartbeat tick that writes a live per-phase cost estimate also recomputes and writes
//     se_runs.cost_usd, so the Runs board / Overview list rows (which read se_runs.cost_usd, not
//     the live phase total) don't lag a whole phase behind while it's running.
//
// Every module runAgentSession touches besides the ones under test is stubbed so the session can
// run end-to-end without a real workspace, SDK, or Supabase project.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../worktree.js', () => ({ makeWorkspace: vi.fn(), cloneBranch: vi.fn(), cloneNewBranch: vi.fn() }));
vi.mock('../input-channel.js', () => ({ subscribeInput: vi.fn(() => null) }));
vi.mock('../agent-session.js', () => {
  const runPhase = vi.fn();
  function InProcessRunner() { this.runPhase = runPhase; }
  return { InProcessRunner, __runPhase: runPhase };
});
vi.mock('../codex-runner.js', () => {
  function CodexRunner() { this.runPhase = vi.fn(); }
  return { CodexRunner };
});
vi.mock('../model-select.js', () => ({ resolvePhaseModel: vi.fn(() => ({ model: 'claude-sonnet-5', engine: 'claude' })) }));
vi.mock('../cost.js', () => ({ estimateLiveCostUSD: vi.fn(async () => 6.89) }));
vi.mock('../credentials.js', () => ({ resolveCommitIdentity: vi.fn() }));
vi.mock('../memory.js', () => ({ recallMemory: vi.fn(async () => ''), listMemorySources: vi.fn(async () => []) }));
vi.mock('../memory-tools.js', () => ({ buildMemoryMcpServer: vi.fn(() => null) }));
vi.mock('../mcp.js', () => ({ resolveMcpServers: vi.fn(() => ({})), mcpSecretValues: vi.fn(() => []) }));
vi.mock('../skills.js', () => ({ resolveProjectSkills: vi.fn(async () => ({ plugins: [], cleanup: vi.fn(async () => {}) })) }));
vi.mock('../process-rules.js', () => ({ fetchProcessRules: vi.fn(async () => '') }));
vi.mock('../git.js', () => ({ redactSecrets: vi.fn((s) => s) }));
vi.mock('../attachments.js', () => ({
  downloadIssueAttachments: vi.fn(async () => ({ count: 0, names: [] })),
  downloadAttachmentUrls: vi.fn(async () => ({ count: 0, names: [] })),
  ATTACH_DIRNAME: '.se-attachments',
}));
vi.mock('../github.js', () => ({ githubClient: vi.fn(() => ({ getIssue: vi.fn(async () => ({ body: '' })) })) }));

import { runAgentSession } from '../phase-runner.js';
import { __runPhase } from '../agent-session.js';

// Chainable supabase double good enough for the reads/writes runAgentSession performs before and
// during the heartbeat. `__updates` records every `.update()` call for assertion; `se_phases`
// selects resolve to `phasesRows()` (a thunk so a test can hand back a fixed snapshot).
function fakeSupabase(phasesRows: () => any[]) {
  const updates: any[] = [];
  const from = (table: string) => {
    const b: any = {
      select() { return b; },
      insert() { return Promise.resolve({ data: null, error: null }); },
      update(row: unknown) { updates.push({ table, row }); return b; },
      upsert() { return Promise.resolve({ data: null, error: null }); },
      eq() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      then(onF: any, onR: any) {
        const payload = table === 'se_phases'
          ? { data: phasesRows(), error: null, count: phasesRows().length }
          : { data: null, error: null, count: 0 };
        return Promise.resolve(payload).then(onF, onR);
      },
    };
    return b;
  };
  return { from, __updates: updates };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('runAgentSession heartbeat cost attribution (issue #55)', () => {
  const RUN = { id: 'run-1', site_id: 'site-1', project_id: 'proj-1', title: 'fix bug' };
  const PROJECT = { modelCredKind: 'api_key', modelCred: 'x', perRunCostCeilingUSD: null };
  const SPEC = { cwd: '/tmp/x', prompt: 'do it', repos: [], allowedTools: [] };

  beforeEach(() => { __runPhase.mockReset(); });

  it('writes the resolved model onto the phase row before the SDK call, then keeps se_runs.cost_usd in sync on each heartbeat tick', async () => {
    const supa = fakeSupabase(() => [{ cost_usd: 6.89 }]);

    let capturedHeartbeat: (() => void) | undefined;
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((fn: any) => { capturedHeartbeat = fn; return 1 as any; }) as any);
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval').mockImplementation((() => {}) as any);

    let resolveRunPhase: () => void = () => {};
    __runPhase.mockImplementation((opts: any) => {
      opts.onUsage({ 'claude-sonnet-5': { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 } });
      return new Promise((res) => { resolveRunPhase = () => res({ text: 'ok', costUSD: 6.89, tokensInput: 100, tokensOutput: 50 }); });
    });

    const promise = runAgentSession(supa, {}, RUN, PROJECT, 'implement', SPEC);

    // Let the pre-SDK-call setup (context assembly, model write, heartbeat registration) settle —
    // it's all already-resolved promises, no real timer needed.
    await tick();
    await tick();

    const modelWrite = supa.__updates.find((u: any) => u.table === 'se_phases' && 'model' in u.row);
    expect(modelWrite).toBeTruthy();
    expect(modelWrite.row).toMatchObject({ model: 'claude-sonnet-5', engine: 'claude' });
    expect(capturedHeartbeat).toBeTruthy();

    // Before any heartbeat tick, se_runs.cost_usd must not have been touched yet.
    expect(supa.__updates.some((u: any) => u.table === 'se_runs' && 'cost_usd' in u.row)).toBe(false);

    capturedHeartbeat!();
    await tick();
    await tick();

    const phaseEstimateWrite = supa.__updates.find((u: any) => u.table === 'se_phases' && 'cost_usd' in u.row && !('model' in u.row));
    expect(phaseEstimateWrite).toBeTruthy();
    expect(phaseEstimateWrite.row.cost_usd).toBe(6.89);

    const runCostWrite = supa.__updates.find((u: any) => u.table === 'se_runs' && 'cost_usd' in u.row);
    expect(runCostWrite).toBeTruthy();
    expect(runCostWrite.row.cost_usd).toBe(6.89);

    resolveRunPhase();
    await promise;

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});

// Pins issue #57: a per-run cost ceiling trip must be machine-distinguishable from an ordinary
// agent-session error, so the five phase workers that hard-fail on `result.error` can instead park
// the run as `blocked` (a config problem, not a crash) rather than dead-ending it as `failed`.
describe('runAgentSession cost ceiling (issue #57)', () => {
  const RUN = { id: 'run-1', site_id: 'site-1', project_id: 'proj-1', title: 'fix bug' };
  const SPEC = { cwd: '/tmp/x', prompt: 'do it', repos: [], allowedTools: [] };

  beforeEach(() => { __runPhase.mockReset(); });

  // Like fakeSupabase, but se_runs.maybeSingle() resolves to a configurable cost_usd — the ceiling
  // check reads this fresh instead of trusting the in-memory `run` object.
  function fakeSupabaseWithRunCost(runCostUsd: number) {
    const from = (table: string) => {
      const b: any = {
        select() { return b; },
        insert() { return Promise.resolve({ data: null, error: null }); },
        update() { return b; },
        upsert() { return Promise.resolve({ data: null, error: null }); },
        eq() { return b; },
        maybeSingle() {
          return Promise.resolve(
            table === 'se_runs' ? { data: { cost_usd: runCostUsd }, error: null } : { data: null, error: null },
          );
        },
        then(onF: any, onR: any) { return Promise.resolve({ data: [], error: null, count: 0 }).then(onF, onR); },
      };
      return b;
    };
    return { from };
  }

  it('returns costCeiling: true and the unchanged error message once spend crosses the ceiling, without invoking the runner', async () => {
    const supa = fakeSupabaseWithRunCost(22.55);
    const PROJECT = { modelCredKind: 'api_key', modelCred: 'x', perRunCostCeilingUSD: 20 };

    const result = await runAgentSession(supa, {}, RUN, PROJECT, 'verify', SPEC);

    expect(result.costCeiling).toBe(true);
    expect(result.error).toBe(
      'cost ceiling reached: this run has spent $22.55 of its $20.00 per-run ceiling — raise it in Setup or split the issue',
    );
    expect(__runPhase).not.toHaveBeenCalled();
  });

  it('does not trip when spend is below the ceiling', async () => {
    const supa = fakeSupabaseWithRunCost(5);
    const PROJECT = { modelCredKind: 'api_key', modelCred: 'x', perRunCostCeilingUSD: 20 };

    __runPhase.mockImplementation((opts: any) => {
      opts.onUsage?.({});
      return Promise.resolve({ text: 'ok', costUSD: 0.1, tokensInput: 1, tokensOutput: 1 });
    });

    const result = await runAgentSession(supa, {}, RUN, PROJECT, 'verify', SPEC);

    expect(result.costCeiling).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(__runPhase).toHaveBeenCalled();
  });
});

// Issue #58: the context-discipline paragraph must reach every repo phase's systemAppend
// automatically, so an agent never needs an operator's hand-typed retry instructions to avoid
// autocompact thrashing from whole-file reads.
describe('runAgentSession systemAppend includes the context-discipline paragraph (issue #58)', () => {
  const RUN = { id: 'run-1', site_id: 'site-1', project_id: 'proj-1', title: 'fix bug' };
  const PROJECT = { modelCredKind: 'api_key', modelCred: 'x', perRunCostCeilingUSD: null };
  const SPEC = { cwd: '/tmp/x', prompt: 'do it', repos: [], allowedTools: [] };

  beforeEach(() => { __runPhase.mockReset(); });

  it('passes the paragraph in systemAppend', async () => {
    const supa = fakeSupabase(() => [{ cost_usd: 0 }]);
    __runPhase.mockImplementation(async () => ({ text: 'ok', costUSD: 0, tokensInput: 1, tokensOutput: 1 }));

    await runAgentSession(supa, {}, RUN, PROJECT, 'implement', SPEC);

    expect(__runPhase).toHaveBeenCalled();
    const opts = __runPhase.mock.calls[0][0];
    expect(opts.systemAppend).toContain('Locate code with Grep or Glob first');
  });
});
