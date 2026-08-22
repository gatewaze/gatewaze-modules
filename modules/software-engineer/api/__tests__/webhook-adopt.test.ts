// @ts-nocheck — vitest harness; the routes are @ts-nocheck'd already.
//
// `agent:adopt` PR-label intake on the GitHub webhook — hand a locally-developed PR to the
// pr-monitor without admin credentials. Contract under test (api/webhook-routes.ts +
// lib/connect-pr.ts, which is REAL here so the shared /prs/connect core is exercised end-to-end):
//   - labeled by a TRUSTED applier (allowed_labellers) on an open PR in a connected code repo →
//     a kind='external_pr' run is created (labeller = the HMAC-verified sender), its se_run_prs row
//     upserted, and the pr-monitor enqueued;
//   - `opened` with agent:adopt in the PR's initial label set → same;
//   - untrusted applier (incl. the empty-allowlist fail-closed case) → ignored with a 200, no run,
//     and NO PR comment (no error-comment loop);
//   - repo not connected to any project → ignored;
//   - dedupe: label re-applied while a live run already watches the PR → no second run, the live
//     run is returned + nudged; a CANCELLED prior run does not block re-adoption;
//   - non-adopt labels fall through to the existing monitor-nudge path;
//   - a bad HMAC signature never reaches any of it.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const state = vi.hoisted(() => ({
  project: null as any,
  codeRepoProject: null as any,
  codeRepos: [] as any[],
  pull: null as any,
  existingRunPr: null as any,   // dedupe row for connect-pr's se_run_prs lookup
  nudgeRunPr: null as any,      // row for the webhook's plain monitor-nudge lookup
  inserts: [] as any[],
  upserts: [] as any[],
  enqueued: [] as any[],
  logs: [] as any[],
  comments: [] as any[],
}));

vi.mock('../../lib/credentials.js', () => ({
  resolveIssuesRepoProject: async () => null,
  resolveCodeRepoProject: async () => state.codeRepoProject,
  getProject: async () => state.project,
  getCodeRepos: async () => state.codeRepos,
}));
vi.mock('../../lib/github.js', () => ({
  githubClient: () => ({
    getPullRequest: async () => state.pull,
    postComment: async (...args: any[]) => { state.comments.push(args); },
  }),
}));
vi.mock('../../lib/rate-limit.js', () => ({
  rateLimit: () => true,
  clientIp: () => '203.0.113.9',
}));
vi.mock('../../lib/dispatch.js', () => ({ dispatchProject: async () => {} }));
vi.mock('../../lib/dependencies.js', () => ({
  parseDependencies: () => [],
  unmetDependencies: async () => [],
  ensureWaitingMarker: async () => {},
}));
vi.mock('../../lib/run-state.js', () => ({
  upsertRunPr: async (_sb: unknown, run: any, owner: string, name: string, patch: any) => {
    state.upserts.push({ runId: run.id, owner, name, patch });
  },
}));

import { mountWebhookRoute } from '../webhook-routes.js';

const SECRET = 'test-webhook-secret';

function mockSupabase() {
  const from = (table: string) => {
    const b: any = { _selected: '' };
    b.select = (cols: string) => { b._selected = String(cols ?? ''); return b; };
    b.eq = () => b;
    b.in = () => b;
    b.maybeSingle = () => {
      if (table === 'se_run_prs') {
        // connect-pr's dedupe joins se_runs; the webhook's nudge lookup selects run_id only.
        if (b._selected.includes('se_runs')) return Promise.resolve({ data: state.existingRunPr, error: null });
        return Promise.resolve({ data: state.nudgeRunPr, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    b.insert = (row: any) => {
      state.inserts.push({ table, row });
      return { select: () => ({ single: () => Promise.resolve({ data: { id: 'run-new' }, error: null }) }) };
    };
    return b;
  };
  return { from };
}

function makeHarness() {
  const routes: Record<string, any> = {};
  const router = { post: (path: string, handler: any) => { routes[path] = handler; } };
  mountWebhookRoute(router, {
    supabase: mockSupabase(),
    enqueueJob: async (...args: any[]) => { state.enqueued.push(args); },
    webhookSecret: SECRET,
    logger: { info: (...a: any[]) => state.logs.push(a), warn: () => {}, error: () => {} },
  });
  return routes['/webhook'];
}

async function deliver(event: string, payload: any, opts: { secret?: string } = {}) {
  const handler = makeHarness();
  const rawBody = Buffer.from(JSON.stringify(payload));
  const sig = 'sha256=' + createHmac('sha256', opts.secret ?? SECRET).update(rawBody).digest('hex');
  const req = {
    body: rawBody,
    headers: { 'x-hub-signature-256': sig, 'x-github-event': event, 'x-github-delivery': 'd-1' },
  };
  const res: any = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  await handler(req, res);
  return res;
}

const REPO = { name: 'webapp', owner: { login: 'acme' } };
const basePayload = (action: string, extra: any = {}) => {
  const { pull_request, ...rest } = extra;
  return {
    action,
    repository: REPO,
    sender: { login: 'dan' },
    pull_request: { number: 42, state: 'open', labels: [], ...pull_request },
    ...rest,
  };
};

beforeEach(() => {
  state.project = {
    projectId: 'proj-1', siteId: 'site-1', githubToken: 'ghp_x', intakeEnabled: true,
    allowedLabellers: ['dan'], primaryInstanceId: null,
  };
  state.codeRepoProject = { projectId: 'proj-1', siteId: 'site-1' };
  state.codeRepos = [{ repoOwner: 'acme', repoName: 'webapp' }];
  state.pull = { state: 'open', title: 'Add the widget', html_url: 'https://github.com/acme/webapp/pull/42', head: { ref: 'feat/widget' } };
  state.existingRunPr = null;
  state.nudgeRunPr = null;
  state.inserts = [];
  state.upserts = [];
  state.enqueued = [];
  state.logs = [];
  state.comments = [];
  delete process.env.SE_INSTANCE_ID;
});

describe('agent:adopt webhook intake', () => {
  it('trusted applier labels an open PR → external_pr run created, PR row upserted, monitor enqueued', async () => {
    const res = await deliver('pull_request', basePayload('labeled', { label: { name: 'agent:adopt' } }));
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ accepted: true, adopted: true, runId: 'run-new' });
    expect(state.inserts).toHaveLength(1);
    const row = state.inserts[0].row;
    expect(state.inserts[0].table).toBe('se_runs');
    expect(row).toMatchObject({
      kind: 'external_pr', project_id: 'proj-1', site_id: 'site-1',
      repo_owner: 'acme', repo_name: 'webapp', pr_number: 42, issue_number: null,
      status: 'watching', current_phase: 'watch', branch_name: 'feat/widget',
      labeller: 'dan', blast_radius: 'needs_human',
    });
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]).toMatchObject({ runId: 'run-new', owner: 'acme', name: 'webapp', patch: { pr_number: 42, state: 'open' } });
    expect(state.enqueued.some((e) => e[1] === 'software-engineer:pr-monitor' && e[2]?.runId === 'run-new')).toBe(true);
  });

  it('opened with agent:adopt in the initial label set → adopted the same way', async () => {
    const res = await deliver('pull_request', basePayload('opened', { pull_request: { labels: [{ name: 'agent:adopt' }, { name: 'enhancement' }] } }));
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ accepted: true, adopted: true });
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].row.labeller).toBe('dan'); // the PR opener applied the initial labels
  });

  it('untrusted applier → ignored with a log line, no run, no PR comment', async () => {
    const res = await deliver('pull_request', { ...basePayload('labeled', { label: { name: 'agent:adopt' } }), sender: { login: 'drive-by' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ accepted: false, reason: 'applier not trusted' });
    expect(state.inserts).toHaveLength(0);
    expect(state.comments).toHaveLength(0);
    expect(state.logs.some((l) => String(l[0]).includes('applier not trusted'))).toBe(true);
  });

  it('empty allowed_labellers fails CLOSED — even the PR author cannot adopt', async () => {
    state.project.allowedLabellers = [];
    const res = await deliver('pull_request', basePayload('labeled', { label: { name: 'agent:adopt' } }));
    expect(res.body).toMatchObject({ accepted: false, reason: 'applier not trusted' });
    expect(state.inserts).toHaveLength(0);
  });

  it('repo not connected to any project → ignored, no token use, no run', async () => {
    state.codeRepoProject = null;
    const res = await deliver('pull_request', basePayload('labeled', { label: { name: 'agent:adopt' } }));
    expect(res.body).toMatchObject({ accepted: false, reason: 'not a connected code repo' });
    expect(state.inserts).toHaveLength(0);
  });

  it('repo resolved but no longer in the project code-repo set → repo_not_connected from the shared core', async () => {
    state.codeRepos = [{ repoOwner: 'acme', repoName: 'otherrepo' }];
    const res = await deliver('pull_request', basePayload('labeled', { label: { name: 'agent:adopt' } }));
    expect(res.body).toMatchObject({ accepted: false, reason: 'repo_not_connected' });
    expect(state.inserts).toHaveLength(0);
  });

  it('project intake disabled (kill switch) → ignored', async () => {
    state.project.intakeEnabled = false;
    const res = await deliver('pull_request', basePayload('labeled', { label: { name: 'agent:adopt' } }));
    expect(res.body).toMatchObject({ accepted: false, reason: 'intake disabled' });
    expect(state.inserts).toHaveLength(0);
  });

  it('dedupe: label re-applied while a live run watches the PR → no second run, live run nudged', async () => {
    state.existingRunPr = { run_id: 'run-live', se_runs: { id: 'run-live', status: 'watching', archived_at: null } };
    const res = await deliver('pull_request', basePayload('labeled', { label: { name: 'agent:adopt' } }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ accepted: false, reason: 'run already live', runId: 'run-live' });
    expect(state.inserts).toHaveLength(0);
    expect(state.enqueued.some((e) => e[1] === 'software-engineer:pr-monitor' && e[2]?.runId === 'run-live')).toBe(true);
  });

  it('a cancelled prior run does not block re-adoption', async () => {
    state.existingRunPr = { run_id: 'run-old', se_runs: { id: 'run-old', status: 'cancelled', archived_at: null } };
    const res = await deliver('pull_request', basePayload('labeled', { label: { name: 'agent:adopt' } }));
    expect(res.statusCode).toBe(202);
    expect(state.inserts).toHaveLength(1);
  });

  it('closed PR cannot be adopted', async () => {
    state.pull = { ...state.pull, state: 'closed' };
    const res = await deliver('pull_request', basePayload('labeled', { label: { name: 'agent:adopt' } }));
    expect(res.body).toMatchObject({ accepted: false, reason: 'pr_not_open' });
    expect(state.inserts).toHaveLength(0);
  });

  it('a git-option-shaped head branch is rejected by the shared core', async () => {
    state.pull = { ...state.pull, head: { ref: '--mirror' } };
    const res = await deliver('pull_request', basePayload('labeled', { label: { name: 'agent:adopt' } }));
    expect(res.body).toMatchObject({ accepted: false, reason: 'bad_branch' });
    expect(state.inserts).toHaveLength(0);
  });

  it('bare agent:adopt only acts on the primary instance', async () => {
    state.project.primaryInstanceId = 'studio';
    const res = await deliver('pull_request', basePayload('labeled', { label: { name: 'agent:adopt' } }));
    expect(res.body).toMatchObject({ accepted: false, reason: 'not this instance' });
    expect(state.inserts).toHaveLength(0);
  });

  it('agent:adopt@<instance> targets exactly that instance', async () => {
    process.env.SE_INSTANCE_ID = 'studio';
    state.project.primaryInstanceId = 'elsewhere';
    const res = await deliver('pull_request', basePayload('labeled', { label: { name: 'agent:adopt@studio' } }));
    expect(res.statusCode).toBe(202);
    expect(state.inserts[0].row.instance_id).toBe('studio');
  });

  it('a non-adopt PR label falls through to the monitor-nudge path', async () => {
    state.nudgeRunPr = { run_id: 'run-live' };
    const res = await deliver('pull_request', basePayload('labeled', { label: { name: 'enhancement' } }));
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ accepted: true, runId: 'run-live', monitor: true });
    expect(state.inserts).toHaveLength(0);
  });

  it('a bad HMAC signature is rejected before any adopt handling', async () => {
    const res = await deliver('pull_request', basePayload('labeled', { label: { name: 'agent:adopt' } }), { secret: 'wrong' });
    expect(res.statusCode).toBe(401);
    expect(state.inserts).toHaveLength(0);
  });
});
