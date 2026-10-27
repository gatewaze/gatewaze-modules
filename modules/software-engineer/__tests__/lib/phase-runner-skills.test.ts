// @ts-nocheck
//
// runAgentSession's skills plumbing: project skills always, the workspace repos' own skills only
// when the phase opts in with `repoSkills` (read from agreementDir when the phase substituted the
// base branch's guardrails), both handed to the SDK as local plugins and both cleaned up after the
// session — and the per-run cost ceiling refusing BEFORE any skills clone exists, so the early
// return cannot leak a credentialed clone.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const runner = vi.hoisted(() => ({ runPhase: vi.fn(), order: [] as string[] }));
vi.mock('../../lib/agent-session.js', () => ({
  InProcessRunner: class { runPhase(input: any) { runner.order.push('runPhase'); return runner.runPhase(input); } },
}));
vi.mock('../../lib/codex-runner.js', () => ({ CodexRunner: class {} }));
vi.mock('../../lib/model-select.js', () => ({ resolvePhaseModel: () => ({ engine: 'claude', model: 'claude-sonnet-5' }) }));
vi.mock('../../lib/cost.js', () => ({ estimateLiveCostUSD: async () => 0 }));
vi.mock('../../lib/run-state.js', () => ({
  writeEvent: async () => {}, writeMessage: async () => {}, touchRun: async () => {},
  drainPendingAdminMessages: async () => '', recomputeRunCost: async () => {},
}));
vi.mock('../../lib/credentials.js', () => ({ resolveCommitIdentity: async () => ({}) }));
vi.mock('../../lib/memory.js', () => ({ recallMemory: async () => '', listMemorySources: async () => [] }));
vi.mock('../../lib/memory-tools.js', () => ({ buildMemoryMcpServer: () => null }));
vi.mock('../../lib/mcp.js', () => ({ resolveMcpServers: () => ({}), mcpSecretValues: () => [] }));
vi.mock('../../lib/process-rules.js', () => ({ fetchProcessRules: async () => '' }));
vi.mock('../../lib/git.js', () => ({ redactSecrets: (m: string) => m }));
vi.mock('../../lib/attachments.js', () => ({ downloadIssueAttachments: async () => ({ count: 0, names: [] }), downloadAttachmentUrls: async () => ({ count: 0, names: [] }), ATTACH_DIRNAME: '.se-attachments' }));
vi.mock('../../lib/github.js', () => ({ githubClient: () => ({ getIssue: async () => ({ body: '' }) }) }));
vi.mock('../../lib/input-channel.js', () => ({ subscribeInput: () => null }));
vi.mock('../../lib/worktree.js', () => ({ makeWorkspace: async () => ({}), cloneBranch: async () => {}, cloneNewBranch: async () => {} }));

const skills = vi.hoisted(() => ({
  project: vi.fn(), local: vi.fn(),
  cleanupProject: vi.fn(async () => { runner.order.push('cleanupProject'); }),
  cleanupLocal: vi.fn(async () => { runner.order.push('cleanupLocal'); }),
}));
vi.mock('../../lib/skills.js', () => ({
  resolveProjectSkills: (...a: any[]) => skills.project(...a),
  resolveRepoLocalSkills: (...a: any[]) => skills.local(...a),
}));

import { runAgentSession } from '../../lib/phase-runner.js';

function mockSupabase(costUsd = 0) {
  const from = (table: string) => {
    const b: any = {
      select() { return b; }, update() { return b; }, eq() { return b; },
      maybeSingle() { return Promise.resolve({ data: table === 'se_runs' ? { cost_usd: costUsd } : null, error: null }); },
      then(onF: any) { return Promise.resolve({ count: 0, data: null, error: null }).then(onF); },
    };
    return b;
  };
  return { from };
}

const P = { type: 'local', path: '/tmp/p/project', skipMcpDiscovery: true };
const L = { type: 'local', path: '/tmp/p/widgets-local', skipMcpDiscovery: true };
const run = { id: 'run-1', site_id: 's', project_id: 'p', title: 't', repo_owner: 'acme', repo_name: 'issues', issue_number: 1 };
const project = { githubToken: 'ghp_x', modelCred: 'c', modelCredKind: 'anthropic_api_key', model: 'claude-sonnet-5', skills: [] };
const repos = [{ repoOwner: 'acme', repoName: 'widgets', dir: '/nonexistent/ws/acme/widgets', writable: true }];

describe('runAgentSession skills plumbing', () => {
  beforeEach(() => {
    runner.order.length = 0;
    runner.runPhase.mockReset().mockResolvedValue({ text: 'ok', tokensInput: 1, tokensOutput: 1, tokensCacheRead: 0, tokensCacheCreation: 0, costUSD: 0, modelUsage: {}, interrupted: false });
    skills.project.mockReset().mockResolvedValue({ plugins: [P], cleanup: skills.cleanupProject });
    skills.local.mockReset().mockResolvedValue({ plugins: [L], cleanup: skills.cleanupLocal });
    skills.cleanupProject.mockClear(); skills.cleanupLocal.mockClear();
  });

  it('with repoSkills: project plugins first, then repo-local ones, and both cleanups run after the session', async () => {
    const result = await runAgentSession(mockSupabase(), {}, run, project, 'pre-pr-review', { cwd: '/nonexistent/ws', prompt: 'go', repos, repoSkills: true });
    expect(result.modelUsed).toBe('claude-sonnet-5');
    expect(runner.runPhase.mock.calls[0][0].plugins).toEqual([P, L]);
    expect(skills.local).toHaveBeenCalledWith([{ repoName: 'widgets', dir: '/nonexistent/ws/acme/widgets' }], undefined);
    expect(runner.order).toEqual(['runPhase', 'cleanupProject', 'cleanupLocal']);
  });

  it('reads repo-local skills from agreementDir when the phase substituted the base guardrails', async () => {
    const r = [{ ...repos[0], agreementDir: '/nonexistent/ws/.se-base-guardrails/acme/widgets' }];
    await runAgentSession(mockSupabase(), {}, run, project, 'pre-pr-review', { cwd: '/nonexistent/ws', prompt: 'go', repos: r, repoSkills: true });
    expect(skills.local).toHaveBeenCalledWith([{ repoName: 'widgets', dir: '/nonexistent/ws/.se-base-guardrails/acme/widgets' }], undefined);
  });

  it('without repoSkills: repo-local skills are never resolved and only project plugins are passed', async () => {
    await runAgentSession(mockSupabase(), {}, run, project, 'implement', { cwd: '/nonexistent/ws', prompt: 'go', repos });
    expect(skills.local).not.toHaveBeenCalled();
    expect(runner.runPhase.mock.calls[0][0].plugins).toEqual([P]);
    expect(runner.order).toEqual(['runPhase', 'cleanupProject']);
  });

  it('the cost ceiling refuses before any skills clone is made', async () => {
    const result = await runAgentSession(mockSupabase(25), {}, run, { ...project, perRunCostCeilingUSD: 20 }, 'pre-pr-review', { cwd: '/nonexistent/ws', prompt: 'go', repos, repoSkills: true });
    expect(result.costCeiling).toBe(true);
    expect(result.error).toContain('cost ceiling reached');
    expect(skills.project).not.toHaveBeenCalled();
    expect(skills.local).not.toHaveBeenCalled();
    expect(runner.runPhase).not.toHaveBeenCalled();
  });
});
