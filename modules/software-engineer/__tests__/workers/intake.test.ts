// @ts-nocheck — vitest harness; the worker is @ts-nocheck'd already.
//
// Locally-authored spec handoff — the intake worker's behavior around the agent:spec:provided /
// agent:spec:approved labels. Contract under test:
//   - provided → the issue-body spec becomes the run's kind='spec' artifact (spec.ts shape), the
//     spec + self-review phases are recorded 'skipped' with no token/cost payload (never billed),
//     and the run parks at the awaiting_spec human gate even when the project's spec gate is OFF;
//   - provided+approved → skips the gate too and goes straight to implement (or architecture when
//     the project has an architecture gate), branch_name set for implement's workspace;
//   - malformed (no extractable spec / approved without provided / oversize) → the run FAILS at
//     intake with the extraction error verbatim, never silently proceeding to the billed spec phase;
//   - no spec labels → the classic path (enqueue spec) is untouched.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MAX_PROVIDED_SPEC_BYTES } from '../../lib/provided-spec.js';

const gh = vi.hoisted(() => ({
  putFileCalls: [] as any[],
  setStatusLabelCalls: [] as any[],
  addLabelsCalls: [] as any[],
  comments: [] as any[],
  issue: { title: 'Fix the widget', body: 'The widget is broken.', labels: [] as any[], user: null },
  getIssueError: null as any,
  // Label-applier provenance (issue events): by default every label on the issue was applied by
  // 'dan', the run's own labeller — the trusted case. Tests override this for the untrusted case.
  events: null as any,
  eventsError: null as any,
}));
vi.mock('../../lib/github.js', () => ({
  githubClient: () => ({
    getIssue: async () => { if (gh.getIssueError) throw gh.getIssueError; return gh.issue; },
    listIssueEvents: async () => {
      if (gh.eventsError) throw gh.eventsError;
      return gh.events ?? gh.issue.labels.map((name: string) => ({ event: 'labeled', label: { name }, actor: { login: 'dan' } }));
    },
    putFile: async (...args: any[]) => { gh.putFileCalls.push(args); },
    setStatusLabel: async (...args: any[]) => { gh.setStatusLabelCalls.push(args); },
    addLabels: async (...args: any[]) => { gh.addLabelsCalls.push(args); },
    postComment: async (_o: string, _n: string, _num: number, body: string) => { gh.comments.push(body); },
  }),
}));

const rs = vi.hoisted(() => ({
  starts: [] as any[], ends: [] as any[], gates: [] as any[], messages: [] as any[], blocks: [] as any[],
}));
vi.mock('../../lib/run-state.js', () => ({
  recordPhaseStart: async (_sb: unknown, run: any, phase: string) => { rs.starts.push({ runId: run.id, phase }); },
  recordPhaseEnd: async (_sb: unknown, run: any, phase: string, status: string, summary?: string, tokens?: unknown) => {
    rs.ends.push({ runId: run.id, phase, status, summary, tokens });
  },
  writeGate: async (_sb: unknown, run: any, gate: string, verdict: string, detail?: unknown) => {
    rs.gates.push({ runId: run.id, gate, verdict, detail });
  },
  writeMessage: async (_sb: unknown, run: any, role: string, content: string) => {
    rs.messages.push({ runId: run.id, role, content });
  },
  blockRun: async (_sb: unknown, _run: any, phase: string, gate: string, reason: string) => {
    rs.blocks.push({ phase, gate, reason });
    return { blocked: reason };
  },
}));

const enqueue = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock('../../lib/enqueue.js', () => ({
  enqueuePhase: async (_ctx: unknown, runId: string, phase: string, data?: unknown) => {
    enqueue.calls.push({ runId, phase, data });
  },
}));

const notify = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock('../../lib/notify.js', () => ({
  notifyGate: async (_project: unknown, run: any, event: string) => { notify.calls.push({ runId: run.id, event }); },
}));

const memory = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock('../../lib/memory.js', () => ({
  writeSpecMemory: async (...args: any[]) => { memory.calls.push(args); },
}));

const proj = vi.hoisted(() => ({ current: {} as any }));
vi.mock('../../lib/credentials.js', () => ({
  getProject: async () => proj.current,
}));

// Not installed in this workspace and never actually invoked — the worker's `sb()` helper prefers
// ctx.supabase (always provided by the tests below), but the module-level import must still resolve.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => { throw new Error('createClient should not be called in tests'); },
}));

import intake from '../../workers/intake.js';

function mockSupabase() {
  const inserts: any[] = [];
  const updates: any[] = [];
  const run = {
    id: 'run-1', site_id: 'site-1', project_id: 'proj-1', status: 'queued', kind: 'issue',
    repo_owner: 'acme', repo_name: 'issues', issue_number: 77, branch_name: null,
    labeller: 'dan', instance_id: null, engineer_name: null,
  };
  const from = (table: string) => {
    const b: any = {
      select() { return b; },
      insert(row: any) { inserts.push({ table, row }); return { then: (f: any) => f({ error: null }) }; },
      update(row: any) { updates.push({ table, row }); return b; },
      eq() { return b; },
      is() { return b; },
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

const SPEC_BODY = [
  'Some intro prose for humans.',
  '',
  '## Spec',
  'Goal: fix the widget renderer.',
  'Approach: patch lib/render.ts, add a regression test.',
  '',
  '## Notes',
  'Unrelated trailing section.',
].join('\n');

describe('intake worker — locally-authored spec handoff', () => {
  beforeEach(() => {
    gh.putFileCalls.length = 0; gh.setStatusLabelCalls.length = 0; gh.addLabelsCalls.length = 0; gh.comments.length = 0;
    gh.issue = { title: 'Fix the widget', body: 'The widget is broken.', labels: [], user: null };
    gh.getIssueError = null;
    gh.events = null;
    gh.eventsError = null;
    rs.starts.length = 0; rs.ends.length = 0; rs.gates.length = 0; rs.messages.length = 0; rs.blocks.length = 0;
    enqueue.calls.length = 0; notify.calls.length = 0; memory.calls.length = 0;
    proj.current = {
      intakeEnabled: true, githubToken: 'ghp_token', name: 'Demo Project',
      allowedLabellers: [], architectureRepo: null, specGate: false,
    };
  });

  it('without spec labels, runs the classic path: enqueue the (billed) spec phase', async () => {
    const { supabase, inserts, updates } = mockSupabase();
    const result = await intake({ data: { runId: 'run-1' } }, { supabase });

    expect(result).toEqual({ ok: true });
    expect(enqueue.calls).toEqual([{ runId: 'run-1', phase: 'spec', data: undefined }]);
    expect(updates.at(-1)?.row).toMatchObject({ status: 'running', current_phase: 'spec' });
    expect(inserts.find((i) => i.table === 'se_artifacts')).toBeUndefined();
  });

  it('agent:spec:provided stores the body spec as the kind=spec artifact, skips spec+review unbilled, and parks at the gate even with the project spec gate OFF', async () => {
    gh.issue = { ...gh.issue, body: SPEC_BODY, labels: ['agent:spec:provided'] };
    const { supabase, inserts, updates } = mockSupabase();
    const result = await intake({ data: { runId: 'run-1' } }, { supabase });

    expect(result).toEqual({ ok: true, providedSpec: true, gated: 'spec' });
    // Same artifact kind/shape the spec phase writes — downstream phases are none the wiser.
    const art = inserts.find((i) => i.table === 'se_artifacts');
    expect(art?.row).toMatchObject({ run_id: 'run-1', site_id: 'site-1', phase: 'spec', kind: 'spec' });
    expect(art?.row.content).toBe('Goal: fix the widget renderer.\nApproach: patch lib/render.ts, add a regression test.');
    // Skipped phases carry NO token/cost payload — never billed.
    const skips = rs.ends.filter((e) => e.status === 'skipped');
    expect(skips.map((e) => e.phase).sort()).toEqual(['review', 'spec']);
    for (const s of skips) expect(s.tokens).toBeUndefined();
    // Parked at the human gate despite specGate:false — the safety catch for provided specs.
    expect(updates.at(-1)?.row).toMatchObject({ status: 'awaiting_spec', current_phase: 'review', branch_name: expect.stringMatching(/^agent\/se-77-/) });
    expect(enqueue.calls).toEqual([]);
    expect(rs.gates).toContainEqual(expect.objectContaining({ gate: 'provided_spec', verdict: 'pass', detail: { source: 'heading', approved: false } }));
    expect(notify.calls).toEqual([{ runId: 'run-1', event: 'Provided spec ready for review' }]);
    // Spec-log parity with the spec phase: issues-repo commit + pending memory page.
    expect(gh.putFileCalls[0]?.[2]).toBe('specs/issue-77.md');
    expect(memory.calls.length).toBe(1);
    expect(gh.comments.at(-1)).toContain('parked for human review');
  });

  it('agent:spec:provided + agent:spec:approved skips the gate: straight to implement, marker extraction preferred', async () => {
    gh.issue = {
      ...gh.issue,
      body: `## Spec\nheading decoy\n\n<!-- se:spec -->\nMarker spec wins.\n<!-- /se:spec -->`,
      labels: ['agent:spec:provided', 'agent:spec:approved'],
    };
    const { supabase, inserts, updates } = mockSupabase();
    const result = await intake({ data: { runId: 'run-1' } }, { supabase });

    expect(result).toEqual({ ok: true, providedSpec: true, next: 'implement' });
    expect(inserts.find((i) => i.table === 'se_artifacts')?.row.content).toBe('Marker spec wins.');
    expect(updates.at(-1)?.row).toMatchObject({ status: 'running', current_phase: 'implement', branch_name: expect.stringMatching(/^agent\/se-77-/) });
    expect(enqueue.calls).toEqual([{ runId: 'run-1', phase: 'implement', data: undefined }]);
    expect(rs.ends.filter((e) => e.status === 'skipped').map((e) => e.phase).sort()).toEqual(['review', 'spec']);
    expect(gh.comments.at(-1)).toContain('pre-approved');
  });

  it('pre-approved path routes through architecture first when the project has an architecture gate (spec-approve parity)', async () => {
    proj.current.architectureRepo = 'acme/architecture';
    gh.issue = { ...gh.issue, body: SPEC_BODY, labels: ['agent:spec:provided', 'agent:spec:approved'] };
    const { supabase } = mockSupabase();
    const result = await intake({ data: { runId: 'run-1' } }, { supabase });

    expect(result).toEqual({ ok: true, providedSpec: true, next: 'architecture' });
    expect(enqueue.calls).toEqual([{ runId: 'run-1', phase: 'architecture', data: undefined }]);
  });

  it('fails intake loud when the label is present but no spec section is extractable', async () => {
    gh.issue = { ...gh.issue, body: 'Just prose, no spec anywhere.', labels: ['agent:spec:provided'] };
    const { supabase, inserts, updates } = mockSupabase();
    const result = await intake({ data: { runId: 'run-1' } }, { supabase });

    expect(result.failed).toMatch(/no spec section found/);
    expect(updates.at(-1)?.row).toMatchObject({ status: 'failed', error: expect.stringMatching(/no spec section found/) });
    expect(rs.ends.at(-1)).toMatchObject({ phase: 'intake', status: 'failed' });
    expect(inserts.find((i) => i.table === 'se_artifacts')).toBeUndefined();
    expect(enqueue.calls).toEqual([]);
    // The issue is never claimed/marked in-progress for a run that failed intake…
    expect(gh.setStatusLabelCalls).toEqual([]);
    // …but the author is told why, so it never silently dies.
    expect(gh.comments.at(-1)).toContain('Cannot start this run');
  });

  it('fails intake when agent:spec:approved is applied without agent:spec:provided', async () => {
    gh.issue = { ...gh.issue, body: SPEC_BODY, labels: ['agent:spec:approved'] };
    const { supabase, updates } = mockSupabase();
    const result = await intake({ data: { runId: 'run-1' } }, { supabase });

    expect(result.failed).toMatch(/requires agent:spec:provided/);
    expect(updates.at(-1)?.row).toMatchObject({ status: 'failed' });
    expect(enqueue.calls).toEqual([]);
  });

  it('fails intake on an oversize provided spec instead of truncating or falling back to the billed spec phase', async () => {
    gh.issue = {
      ...gh.issue,
      body: `<!-- se:spec -->${'x'.repeat(MAX_PROVIDED_SPEC_BYTES + 1)}<!-- /se:spec -->`,
      labels: ['agent:spec:provided'],
    };
    const { supabase, inserts } = mockSupabase();
    const result = await intake({ data: { runId: 'run-1' } }, { supabase });

    expect(result.failed).toMatch(/exceeds the 64KB cap/);
    expect(inserts.find((i) => i.table === 'se_artifacts')).toBeUndefined();
    expect(enqueue.calls).toEqual([]);
  });

  it('ignores spec labels applied by an untrusted user — classic path, no gate skip (fail closed)', async () => {
    // Same authz rule as the agent:model:*/agent:engine:* overrides: GitHub label-write (triage
    // role) is broader than allowed_labellers, so the label's mere presence proves nothing. An
    // untrusted applier must not be able to skip the self-review or the human gate.
    gh.issue = { ...gh.issue, body: SPEC_BODY, labels: ['agent:spec:provided', 'agent:spec:approved'] };
    gh.events = gh.issue.labels.map((name) => ({ event: 'labeled', label: { name }, actor: { login: 'drive-by-triager' } }));
    const { supabase, inserts, updates } = mockSupabase();
    const result = await intake({ data: { runId: 'run-1' } }, { supabase });

    expect(result).toEqual({ ok: true });
    expect(enqueue.calls).toEqual([{ runId: 'run-1', phase: 'spec', data: undefined }]);
    expect(updates.at(-1)?.row).toMatchObject({ status: 'running', current_phase: 'spec' });
    expect(inserts.find((i) => i.table === 'se_artifacts')).toBeUndefined();
  });

  it('trusts spec labels applied by an allowed labeller who is not the trigger labeller', async () => {
    proj.current.allowedLabellers = ['spec-author'];
    gh.issue = { ...gh.issue, body: SPEC_BODY, labels: ['agent:spec:provided'] };
    gh.events = [{ event: 'labeled', label: { name: 'agent:spec:provided' }, actor: { login: 'spec-author' } }];
    const { supabase, updates } = mockSupabase();
    const result = await intake({ data: { runId: 'run-1' } }, { supabase });

    expect(result).toEqual({ ok: true, providedSpec: true, gated: 'spec' });
    expect(updates.at(-1)?.row).toMatchObject({ status: 'awaiting_spec' });
  });

  it('ignores spec labels when the applier cannot be resolved (events fetch fails) — fail closed', async () => {
    gh.issue = { ...gh.issue, body: SPEC_BODY, labels: ['agent:spec:provided'] };
    gh.eventsError = new Error('events unavailable');
    const { supabase } = mockSupabase();
    const result = await intake({ data: { runId: 'run-1' } }, { supabase });

    expect(result).toEqual({ ok: true });
    expect(enqueue.calls).toEqual([{ runId: 'run-1', phase: 'spec', data: undefined }]);
  });

  it('takes the classic path when the issue fetch fails (labels are only knowable from the fetch)', async () => {
    // Intake learns labels exclusively from its own issue fetch; when that fails it cannot see the
    // spec labels and the run proceeds down the classic (spec-authoring) pipeline. The !issue
    // fail-loud guard in the worker is defense-in-depth for a future trigger that plumbs labels in.
    gh.getIssueError = new Error('boom');
    gh.issue = { ...gh.issue, labels: ['agent:spec:provided'] };
    const { supabase, updates } = mockSupabase();
    const result = await intake({ data: { runId: 'run-1' } }, { supabase });

    // With the fetch failed, intake cannot see labels either — it takes the classic path.
    expect(result).toEqual({ ok: true });
    expect(enqueue.calls).toEqual([{ runId: 'run-1', phase: 'spec', data: undefined }]);
    expect(updates.at(-1)?.row).toMatchObject({ status: 'running', current_phase: 'spec' });
  });
});
