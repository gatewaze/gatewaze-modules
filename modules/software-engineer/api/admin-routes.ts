// @ts-nocheck — express + supabase resolved at module-host install time.
/**
 * Admin API (JWT + is_admin gated by the platform for this prefix). Runs board + run detail, the
 * interactive control surface (chat into a live run, override, cancel), run archiving, and Setup:
 * PROJECTS — each project holds ALL credentials (git PAT + Claude model cred), its repos, shared
 * memory, policy, and a concurrency cap. Engineers are ephemeral (one per run, run.engineer_name).
 */
import { randomUUID } from 'node:crypto';
import { publishInput } from '../lib/input-channel.js';
import { sealToken, getProject, getCodeRepos } from '../lib/credentials.js';
import { githubClient } from '../lib/github.js';
import { mergeRunPrs } from '../lib/merge-prs.js';
import { dispatchProject } from '../lib/dispatch.js';
import { enqueuePhase } from '../lib/enqueue.js';
import { assertRemoteMcpServers } from '../lib/mcp.js';
import { isAllowedAttachmentUrl } from '../lib/attachments.js';
import { rateLimit, clientIp } from '../lib/rate-limit.js';
import { classifyPr, summarizeChecks, summarizeReviews } from '../lib/pr-status.js';
import { readLiveMemory, readPendingMemory, approveMemory, rejectMemory, listMemorySources, linkMemorySource, unlinkMemorySource } from '../lib/memory.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Allowlist of valid se_runs.status values (mirrors the CHECK constraint in migration 003). The
// /runs board accepts a comma-separated status set from the Overview KPI tiles; every value is
// validated against this set so a caller can't smuggle an arbitrary string into the filter.
const RUN_STATUSES = new Set([
  'queued', 'running', 'blocked', 'failed', 'pr_open', 'watching', 'changes_requested', 'merged', 'closed', 'cancelled',
]);

const PROJECT_MASKED =
  'id, site_id, name, description, avatar_emoji,' +
  ' issues_repo_owner, issues_repo_name, trigger_label, primary_instance_id, max_code_repos_per_run,' +
  ' github_token_last4, github_token_kind, github_app_installation_id, github_health, github_checked_at,' +
  ' github_user_login, github_user_id, github_user_name,' +
  ' model_cred_last4, model_cred_kind, model, model_health, model_checked_at,' +
  ' commit_author_name, commit_author_email,' +
  ' allowed_labellers, intake_enabled, autonomy_mode, max_concurrent_engineers, max_interactive_engineers,' +
  ' has_mcp_config,' +
  ' monthly_token_budget, per_run_token_ceiling, per_run_wallclock_minutes, created_at, updated_at';

const sanitize = (v: unknown) =>
  v == null ? null : String(v).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200) || null;

// Friendly display names for interactive sessions (UI only, mirrors the ephemeral engineer names).
const INTERACTIVE_NAMES = ['Ada', 'Max', 'Iris', 'Reed', 'Nova', 'Cleo', 'Rex', 'Milo', 'Juno', 'Otto', 'Vera', 'Kai'];

// AuthZ. The platform's modulesRouter already verifies the user JWT for this /admin/* prefix and
// attaches req.userId (a 401 here without a Bearer confirms it runs). On top of that we require the
// caller to be an ACTIVE admin — these routes hold GitHub PATs, model credentials and MCP configs, so
// a merely-authenticated user must not reach them. This mirrors the is_admin() SQL predicate RLS uses:
// an active admin_profiles row with an elevated role. Service-role client can read admin_profiles.
const ADMIN_ROLES = new Set(['super_admin', 'admin', 'editor']);
export function mountAdminRoutes(router, deps) {
  const { supabase, getRedis, logger, enqueueJob } = deps;

  // Admin gate — runs BEFORE body parsing so unauthorized requests are rejected before we read a body.
  router.use(async (req, res, next) => {
    if (!rateLimit(`se-admin:${clientIp(req)}`, 240, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    if (process.env.GATEWAZE_TEST_DISABLE_AUTH === '1') return next(); // parity with platform requireJwt test bypass
    const userId = req.userId ?? req.auth?.userId ?? req.user?.id ?? null;
    if (!userId) return res.status(401).json({ error: { code: 'unauthenticated', message: 'Missing user context' } });
    try {
      const { data, error } = await supabase
        .from('admin_profiles').select('role').eq('user_id', userId).eq('is_active', true).maybeSingle();
      if (error) return res.status(500).json({ error: { code: 'authz_failed', message: 'Could not verify admin access' } });
      if (!data || !ADMIN_ROLES.has(data.role)) return res.status(403).json({ error: { code: 'forbidden', message: 'Admin access required' } });
      next();
    } catch {
      return res.status(500).json({ error: { code: 'authz_failed', message: 'Could not verify admin access' } });
    }
  });

  // NOTE: do NOT add a body parser here. The platform applies a global
  // express.json() (packages/api/src/server.ts) that consumes the request stream
  // before any module router runs, so req.body is already populated. A second
  // express.json() on this router re-reads the now-consumed stream and throws
  // "stream is not readable" (Express default 500) on every PUT/POST with a body —
  // which broke saving project credentials. Rely on the global parser.

  const authorOf = (req) => req.userId ?? req.auth?.userId ?? req.user?.id ?? req.actor?.userId ?? null;

  // ── Project memory: review + human approval (memory-poisoning gate) ────────
  // reflect writes proposed memory to a pending slot; it is NOT injected into
  // any run until an admin approves it here. All three routes are admin-gated
  // by the router.use above.
  router.get('/projects/:id/memory', async (req, res) => {
    const projectId = String(req.params.id);
    const project = await getProject(supabase, projectId);
    if (!project) return res.status(404).json({ error: { code: 'not_found', message: 'Project not found' } });
    const [live, pending] = await Promise.all([readLiveMemory(projectId), readPendingMemory(projectId)]);
    return res.json({ live, pending, hasPending: !!pending });
  });
  router.post('/projects/:id/memory/approve', async (req, res) => {
    const projectId = String(req.params.id);
    const project = await getProject(supabase, projectId);
    if (!project) return res.status(404).json({ error: { code: 'not_found', message: 'Project not found' } });
    const ok = await approveMemory(supabase, projectId, project.name);
    if (!ok) return res.status(409).json({ error: { code: 'no_pending', message: 'No pending memory to approve' } });
    return res.json({ approved: true });
  });
  router.post('/projects/:id/memory/reject', async (req, res) => {
    const projectId = String(req.params.id);
    const project = await getProject(supabase, projectId);
    if (!project) return res.status(404).json({ error: { code: 'not_found', message: 'Project not found' } });
    await rejectMemory(supabase, projectId, project.name);
    return res.json({ rejected: true });
  });

  // Linked memory sources (§9): other projects whose APPROVED memory this project also recalls.
  // Directional and opt-in; backed by wiki grants. Only same-tenant projects may be linked.
  router.get('/projects/:id/memory/sources', async (req, res) => {
    const projectId = String(req.params.id);
    const project = await getProject(supabase, projectId);
    if (!project) return res.status(404).json({ error: { code: 'not_found', message: 'Project not found' } });
    const ids = await listMemorySources(supabase, projectId);
    let sources: Array<{ projectId: string; name: string }> = [];
    if (ids.length) {
      const { data } = await supabase.from('se_projects').select('id, name').in('id', ids);
      sources = (data ?? []).map((p) => ({ projectId: p.id, name: p.name }));
    }
    return res.json({ sources });
  });
  router.put('/projects/:id/memory/sources', async (req, res) => {
    const projectId = String(req.params.id);
    const project = await getProject(supabase, projectId);
    if (!project) return res.status(404).json({ error: { code: 'not_found', message: 'Project not found' } });
    const raw = Array.isArray(req.body?.source_project_ids) ? req.body.source_project_ids : null;
    if (!raw) return res.status(400).json({ error: { code: 'invalid_input', message: 'source_project_ids array required' } });
    // Allowlist: valid UUIDs, not self, and belonging to THIS tenant (site) — never link an arbitrary
    // project/use_case (that would leak another tenant's memory into this project's runs).
    const wanted = [...new Set(raw.map((x: unknown) => String(x)))].filter((x) => UUID.test(x) && x !== projectId);
    let valid: string[] = [];
    if (wanted.length) {
      const { data } = await supabase.from('se_projects').select('id').in('id', wanted).eq('site_id', project.siteId);
      valid = (data ?? []).map((p) => p.id);
    }
    const current = await listMemorySources(supabase, projectId);
    const toLink = valid.filter((id) => !current.includes(id));
    const toUnlink = current.filter((id) => !valid.includes(id));
    for (const id of toLink) await linkMemorySource(supabase, projectId, id);
    for (const id of toUnlink) await unlinkMemorySource(supabase, projectId, id);
    return res.json({ sources: valid, linked: toLink.length, unlinked: toUnlink.length });
  });
  // Freeing a slot (cancel/archive) should promote the next queued run for that project immediately,
  // rather than waiting for the pr-monitor cron safety-net.
  const dispatchFor = async (runId: string) => {
    try {
      const { data } = await supabase.from('se_runs').select('project_id').eq('id', runId).maybeSingle();
      if (data?.project_id) await dispatchProject(supabase, { enqueueJob }, data.project_id);
    } catch { /* best-effort */ }
  };

  // ── Overview — one pre-aggregated metrics blob for the dashboard's Overview tab ───────────
  // All aggregation happens in the se_overview() SQL function (read-only), so the client renders
  // KPI tiles + rollups from a single JSON payload instead of pulling every run row. Optional
  // ?project=<uuid> scopes every metric to one project.
  router.get('/overview', async (req, res) => {
    let project: string | null = null;
    if (req.query.project !== undefined) {
      project = String(req.query.project);
      if (!UUID.test(project)) return res.status(400).json({ error: 'bad project' });
    }
    const { data, error } = await supabase.rpc('se_overview', { p_project: project });
    if (error) {
      logger?.warn?.('se: overview failed', { error: String(error?.message ?? error) });
      return res.status(500).json({ error: 'overview failed' });
    }
    res.json(data ?? {});
  });

  // ── Overview PR board — every open PR AUTHORED by each project's PAT user ─────────────────
  // Live GitHub view (not just se_run_prs): `author:@me` search per project token, so PRs the
  // user opened OUTSIDE Gatewaze appear too. Each PR is enriched (merge state, latest reviews,
  // check-run rollup), correlated with its SE run when one exists, and classified into a derived
  // "who acts next" status (lib/pr-status.ts) so the dashboard answers it without opening the PR.
  // ~3 GitHub calls per PR → cached per scope for PR_BOARD_TTL_MS; ?refresh=1 busts the cache.
  const prBoardCache = new Map<string, { at: number; payload: unknown }>();
  const PR_BOARD_TTL_MS = 60_000;

  router.get('/overview/prs', async (req, res) => {
    let project: string | null = null;
    if (req.query.project !== undefined && req.query.project !== '') {
      project = String(req.query.project);
      if (!UUID.test(project)) return res.status(400).json({ error: 'bad project' });
    }
    const cacheKey = project ?? 'all';
    const cached = prBoardCache.get(cacheKey);
    if (cached && Date.now() - cached.at < PR_BOARD_TTL_MS && req.query.refresh !== '1') {
      return res.json({ ...(cached.payload as Record<string, unknown>), cached: true });
    }

    // Cap the per-request fan-out: each project costs up to ~150 live GitHub calls (50 PRs × 3),
    // so bound the number of projects one uncached request may process (security-review advisory).
    let pq = supabase.from('se_projects').select('id, name, avatar_emoji, autonomy_mode').order('name').limit(10);
    if (project) pq = pq.eq('id', project);
    const { data: projRows } = await pq;

    // SE-run linkage: open PR rows → their runs, keyed owner/name#number.
    const { data: linkRows } = await supabase
      .from('se_run_prs')
      .select('repo_owner, repo_name, pr_number, se_runs(id, project_id, status, blast_radius, issue_number, engineer_name)')
      .not('pr_number', 'is', null)
      .eq('state', 'open');
    const runByPr = new Map<string, Record<string, unknown>>();
    for (const row of linkRows ?? []) {
      const run = Array.isArray(row.se_runs) ? row.se_runs[0] : row.se_runs;
      if (run) runByPr.set(`${row.repo_owner}/${row.repo_name}#${row.pr_number}`, run);
    }

    const prs: Record<string, unknown>[] = [];
    const seen = new Map<string, number>();   // dedupe when projects share a PAT user
    const projectErrors: Record<string, string> = {};
    // Per-request cache: does the project token owner have write/merge access on a repo? One extra
    // GitHub call per unique repo (not per PR). Distinguishes "you can merge" from "waiting on a
    // maintainer" so an author's own green PR on a repo they can't push to isn't mislabelled "you".
    const repoCanMerge = new Map<string, boolean>();
    const canMergeRepo = async (gh: ReturnType<typeof githubClient>, owner: string, name: string): Promise<boolean> => {
      const k = `${owner}/${name}`.toLowerCase();
      if (repoCanMerge.has(k)) return repoCanMerge.get(k) as boolean;
      let can = true;   // unknown → assume actionable (don't silently hide), corrected when the call succeeds
      try {
        const repo = await gh.getRepo(owner, name);
        const perm = (repo?.permissions ?? {}) as Record<string, boolean>;
        can = !!(perm.admin || perm.maintain || perm.push);
      } catch { /* keep the safe default */ }
      repoCanMerge.set(k, can);
      return can;
    };

    for (const p of projRows ?? []) {
      const proj = await getProject(supabase, p.id);
      if (!proj?.githubToken) continue;
      // Board scope: ONLY the project's connected (enabled) code repos — that set IS the relevance
      // boundary, so we show EVERY open PR in them (the whole team's, not just the PAT user's), which
      // is what "everything the project has open" means. The connected-repo filter (not author) is
      // what keeps a personal PAT's unrelated personal/org PRs off the board.
      const codeRepos = await getCodeRepos(supabase, p.id);
      const connected = new Set(codeRepos.map((r) => `${r.repoOwner}/${r.repoName}`.toLowerCase()));
      if (connected.size === 0) continue;
      const gh = githubClient(proj.githubToken);
      let items: Record<string, unknown>[] = [];
      try {
        const search = await gh.searchAuthoredOpenPRs(50, [...connected], false);
        // Second gate on the results themselves (search-qualifier quirks, forks, renames):
        // anything not in the connected set is dropped.
        items = (search?.items ?? []).filter((item: Record<string, unknown>) => {
          const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(String(item.repository_url ?? ''));
          return m ? connected.has(`${m[1]}/${m[2]}`.toLowerCase()) : false;
        });
      } catch (e) {
        projectErrors[p.name] = 'GitHub search failed — token may lack scopes or be rate-limited';
        logger?.warn?.('se: pr-board search failed', { project: p.id, error: String((e as Error)?.message ?? e) });
        continue;
      }

      // Enrich in small batches — 3 calls per PR against the project PAT.
      const BATCH = 5;
      for (let b = 0; b < items.length; b += BATCH) {
        await Promise.all(items.slice(b, b + BATCH).map(async (item) => {
          const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(String(item.repository_url ?? ''));
          if (!m) return;
          const [, owner, name] = m;
          const number = Number(item.number);
          const key = `${owner}/${name}#${number}`;
          const dup = seen.get(key);
          if (dup !== undefined) {
            (prs[dup].projects as string[]).push(p.name);
            return;
          }
          const base: Record<string, unknown> = {
            repo: `${owner}/${name}`, number, title: String(item.title ?? ''), url: item.html_url,
            author: item.user?.login ?? null, created_at: item.created_at, updated_at: item.updated_at,
            projects: [p.name], project_id: p.id, run: null,   // project_id: whose token found it (for notify)
          };
          try {
            const pull = await gh.getPullRequest(owner, name, number);
            const [reviews, checksResp] = await Promise.all([
              gh.listReviews(owner, name, number).catch(() => []),
              pull?.head?.sha ? gh.listCheckRuns(owner, name, pull.head.sha).catch(() => null) : null,
            ]);
            const checks = summarizeChecks(checksResp?.check_runs);
            const reviewsSum = summarizeReviews(reviews);
            const link = runByPr.get(key);
            // The board is an author:@me search, so the token owner authored these — they can't review
            // or approve their own PR. Surface who GitHub is actually waiting on, and whether the owner
            // can merge, so "needs review / ready to merge" lands on reviewers, not falsely on "you".
            const viewerLogin = String(proj.githubUserLogin ?? '').toLowerCase();
            const viewerIsAuthor = !!viewerLogin && String(item.user?.login ?? '').toLowerCase() === viewerLogin;
            const rawReviewers = (pull.requested_reviewers ?? []) as Array<Record<string, unknown>>;
            const viewerIsRequestedReviewer = !!viewerLogin && rawReviewers.some((u) => String(u?.login ?? '').toLowerCase() === viewerLogin);
            const requestedReviewers = [
              ...rawReviewers.map((u) => String(u?.login ?? '')).filter(Boolean),
              ...((pull.requested_teams ?? []) as Array<Record<string, unknown>>).map((t) => (t?.slug ? `${t.slug} (team)` : '')).filter(Boolean),
            ];
            const viewerCanMerge = await canMergeRepo(gh, owner, name);
            const derived = classifyPr({
              state: pull.state, merged: !!pull.merged, draft: !!pull.draft,
              mergeableState: String(pull.mergeable_state ?? 'unknown'),
              checks, reviews: reviewsSum, viewerIsAuthor, viewerCanMerge, viewerIsRequestedReviewer,
              run: link ? { status: String(link.status), blastRadius: String(link.blast_radius), autonomyMode: String(p.autonomy_mode ?? 'pr_only') } : null,
            });
            seen.set(key, prs.length);
            prs.push({
              ...base, ...derived,
              draft: !!pull.draft, mergeable_state: pull.mergeable_state, base_ref: pull.base?.ref,
              additions: pull.additions, deletions: pull.deletions, changed_files: pull.changed_files,
              checks, reviews: reviewsSum, reviewers: requestedReviewers, viewer_can_merge: viewerCanMerge,
              run: link ? { issue_number: link.issue_number, status: link.status, blast_radius: link.blast_radius, engineer_name: link.engineer_name, project_id: link.project_id } : null,
            });
          } catch {
            // Enrichment failed (permissions, deleted repo, rate limit) — still show the PR.
            seen.set(key, prs.length);
            prs.push({ ...base, status: 'unknown', actor: 'none', label: 'Unavailable', detail: 'Could not load PR details with this project’s token.' });
          }
        }));
      }
    }

    // "Who acts next" first: you → agent → auto → none; newest activity first within a group.
    const actorRank: Record<string, number> = { you: 0, reviewers: 1, agent: 2, auto: 3, none: 4 };
    prs.sort((a, b) =>
      (actorRank[String(a.actor)] ?? 9) - (actorRank[String(b.actor)] ?? 9)
      || String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
    const counts: Record<string, number> = {};
    for (const pr of prs) counts[String(pr.status)] = (counts[String(pr.status)] ?? 0) + 1;

    const payload = { prs, counts, project_errors: projectErrors, generated_at: new Date().toISOString() };
    prBoardCache.set(cacheKey, { at: Date.now(), payload });
    res.json(payload);
  });

  // Nudge the required reviewers on a PR the board is waiting on (the "Awaiting reviewers" group).
  // Params ride the query string (not a JSON body) on purpose: the platform's global parser already
  // consumed the request stream, so a body here can't be re-read. Posts one comment @-mentioning the
  // PR's currently-requested reviewers, via the PROJECT token, and ONLY on a repo connected to the
  // project — the token must never be used to comment on an arbitrary repository.
  router.post('/prs/notify-reviewers', async (req, res) => {
    if (!rateLimit(`se-admin:notify:${clientIp(req)}`, 30, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    const projectId = String(req.query.project ?? '');
    const owner = String(req.query.owner ?? '').trim();
    const name = String(req.query.name ?? '').trim();
    const number = Number(req.query.number);
    if (!UUID.test(projectId)) return res.status(400).json({ error: 'project required' });
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name) || !Number.isInteger(number) || number <= 0) {
      return res.status(400).json({ error: 'bad repo or PR number' });
    }
    const proj = await getProject(supabase, projectId);
    if (!proj?.githubToken) return res.status(400).json({ error: 'project has no GitHub token' });
    const codeRepos = await getCodeRepos(supabase, projectId);
    const connected = new Set(codeRepos.map((r) => `${r.repoOwner}/${r.repoName}`.toLowerCase()));
    if (!connected.has(`${owner}/${name}`.toLowerCase())) return res.status(403).json({ error: 'repo is not connected to this project' });

    const gh = githubClient(proj.githubToken);
    try {
      const pull = await gh.getPullRequest(owner, name, number);
      if (!pull || pull.state !== 'open') return res.status(409).json({ error: 'PR is not open' });
      const users = ((pull.requested_reviewers ?? []) as Array<Record<string, unknown>>).map((u) => String(u?.login ?? '')).filter((s) => /^[A-Za-z0-9-]+$/.test(s));
      const teams = ((pull.requested_teams ?? []) as Array<Record<string, unknown>>).map((t) => String(t?.slug ?? '')).filter((s) => /^[A-Za-z0-9-]+$/.test(s));
      if (users.length === 0 && teams.length === 0) {
        return res.status(409).json({ error: { code: 'no_reviewers', message: 'No reviewers are requested on this PR yet — request one on GitHub first.' } });
      }
      const mentions = [...users.map((u) => `@${u}`), ...teams.map((t) => `@${owner}/${t}`)].join(' ');
      const body = `👋 This PR is ready for your review — checks are green and it's waiting on a required review. ${mentions}`;
      await gh.postComment(owner, name, number, body);
      res.json({ notified: true, reviewers: users, teams });
    } catch (e) {
      logger?.warn?.('se: notify-reviewers failed', { project: projectId, error: String((e as Error)?.message ?? e) });
      res.status(500).json({ error: 'notify failed' });
    }
  });

  // ── Runs ────────────────────────────────────────────────────────────────
  router.get('/runs', async (req, res) => {
    let q = supabase
      .from('se_runs')
      .select('*, project:se_projects(name, avatar_emoji)')
      .order('created_at', { ascending: false })
      .limit(200);
    if (String(req.query.archived) === '1') q = q.not('archived_at', 'is', null);
    else q = q.is('archived_at', null);
    if (req.query.status !== undefined) {
      // Accept a comma-separated status set (KPI-tile deep links) or a single status. Only
      // allowlisted values are kept: a single value → .eq() (backward compatible), a set → .in().
      // A non-empty filter of only-invalid values collapses to .in([]) so it returns no rows rather
      // than silently dropping the filter and dumping the whole board.
      const wanted = [...new Set(String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean))];
      const valid = wanted.filter((s) => RUN_STATUSES.has(s));
      if (wanted.length === 1) q = q.eq('status', valid[0] ?? '__none__');
      else if (wanted.length > 1) q = q.in('status', valid);
    }
    if (req.query.repo) q = q.eq('repo_name', String(req.query.repo));
    if (req.query.project && UUID.test(String(req.query.project))) q = q.eq('project_id', String(req.query.project));
    const { data } = await q;
    res.json({ runs: data ?? [] });
  });

  router.get('/runs/:id', async (req, res) => {
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const [run, phases, events, gates, artifacts, messages] = await Promise.all([
      supabase.from('se_runs').select('*, project:se_projects(name, avatar_emoji)').eq('id', id).maybeSingle(),
      supabase.from('se_phases').select('*').eq('run_id', id).order('started_at', { nullsFirst: true }),
      supabase.from('se_events').select('*').eq('run_id', id).order('seq').limit(2000),
      supabase.from('se_gates').select('*').eq('run_id', id).order('created_at'),
      supabase.from('se_artifacts').select('*').eq('run_id', id).order('created_at'),
      supabase.from('se_messages').select('*').eq('run_id', id).order('id'),
    ]);
    if (!run.data) return res.status(404).json({ error: 'not found' });
    res.json({
      run: run.data, phases: phases.data ?? [], events: events.data ?? [],
      gates: gates.data ?? [], artifacts: artifacts.data ?? [], messages: messages.data ?? [],
    });
  });

  router.post('/runs/:id/message', async (req, res) => {
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const content = String(req.body?.content ?? '').slice(0, 8000);
    // Chat image attachments (pasted screenshots) — already uploaded to the public `media` bucket by
    // the client. Validate each URL against the host allowlist (defense in depth: the runner's
    // download path allowlists again) and cap the count, exactly like the issue-create path.
    // We keep the candidate count so the response can report how many were DROPPED by the allowlist —
    // otherwise a non-allowlisted URL (e.g. an http `.localhost` storage URL in dev, or a split-horizon
    // storage origin in a self-hosted prod) is silently stripped and the caller believes it attached.
    const candidateImages = (Array.isArray(req.body?.images) ? req.body.images : [])
      .map((u: any) => (typeof u === 'string' ? u : u?.url))
      .filter((u: any) => typeof u === 'string' && u.length > 0)
      .slice(0, 8);
    const images = candidateImages.filter((u: string) => isAllowedAttachmentUrl(u));
    const imagesDropped = candidateImages.length - images.length;
    if (!content.trim() && !images.length) return res.status(400).json({ error: 'empty' });
    const { data: run } = await supabase.from('se_runs').select('id, site_id, status').eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: 'not found' });
    if (!['queued', 'running', 'changes_requested'].includes(run.status)) return res.status(409).json({ error: `run is ${run.status}` });
    // Persist the images as markdown appended to the stored message so the transcript renders them
    // inline — the same `![](url)` convention se_messages already carries for issue attachments.
    const stored = images.length
      ? `${content}${content && '\n\n'}` + images.map((u: string, i: number) => `![screenshot-${i + 1}](${u})`).join('\n')
      : content;
    await supabase.from('se_messages').insert({ run_id: id, site_id: run.site_id, role: 'admin', author: authorOf(req), content: stored });
    try { await publishInput(getRedis?.(), id, { kind: 'chat', content, images }); }
    catch (e) { logger?.warn?.('se: publish chat failed', { error: String(e) }); }
    res.status(202).json({ accepted: true, attachmentsAttached: images.length, attachmentsDropped: imagesDropped });
  });

  router.post('/runs/:id/interrupt', async (req, res) => {
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const content = req.body?.content ? String(req.body.content).slice(0, 8000) : undefined;
    const { data: run } = await supabase.from('se_runs').select('id, site_id').eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: 'not found' });
    await supabase.from('se_messages').insert({ run_id: id, site_id: run.site_id, role: 'system', author: authorOf(req), content: content ? `override → ${content}` : 'interrupt' });
    try { await publishInput(getRedis?.(), id, { kind: 'interrupt', content }); }
    catch (e) { logger?.warn?.('se: publish interrupt failed', { error: String(e) }); }
    res.status(202).json({ accepted: true });
  });

  // End an interactive (pair-programming) session. Publishes a `close` so the live session ends
  // gracefully (the worker cleans up its workspace and marks the run 'closed'), and also marks it
  // closed here as a robust fallback so the slot frees even if the worker is already gone. Idempotent
  // with the worker's own close (both set 'closed'). Only valid for kind='interactive'.
  router.post('/runs/:id/close', async (req, res) => {
    if (!rateLimit(`se-admin:close:${clientIp(req)}`, 60, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const { data: run } = await supabase.from('se_runs').select('id, site_id, kind, status').eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: 'not found' });
    if (run.kind !== 'interactive') return res.status(400).json({ error: 'not an interactive session' });
    try { await publishInput(getRedis?.(), id, { kind: 'close' }); }
    catch (e) { logger?.warn?.('se: publish close failed', { error: String(e) }); }
    await supabase.from('se_runs').update({ status: 'closed' }).eq('id', id).eq('kind', 'interactive').in('status', ['running']);
    try { await supabase.from('se_messages').insert({ run_id: id, site_id: run.site_id, role: 'system', author: authorOf(req), content: 'Session closed by admin.' }); } catch { /* best-effort */ }
    res.json({ status: 'closed' });
  });

  router.post('/runs/:id/cancel', async (req, res) => {
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const { error } = await supabase.from('se_runs').update({ status: 'cancelled' }).eq('id', id)
      .in('status', ['queued', 'running', 'blocked', 'watching', 'changes_requested', 'pr_open']);
    try { await publishInput(getRedis?.(), id, { kind: 'interrupt' }); } catch { /* best effort */ }
    if (error) return res.status(500).json({ error: 'update failed' });
    await dispatchFor(id);   // freed a slot → promote the next queued run
    res.json({ status: 'cancelled' });
  });

  // Manually merge a run's open, mergeable PR(s) from the Runs dashboard — the human counterpart to the
  // autonomous workers/merge.ts. It deliberately BYPASSES the autonomy/blast gate (an admin is explicitly
  // asking, which is the whole point for pr_only projects and needs_human runs) but keeps every other
  // safety property: mergeRunPrs only merges PRs GitHub reports mergeable_state 'clean', and the project's
  // non-bypass token means a red/required-checks-failing PR still can't be forced — it's held, not merged.
  router.post('/runs/:id/merge', async (req, res) => {
    if (!rateLimit(`se-admin:merge:${clientIp(req)}`, 30, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const { data: run } = await supabase.from('se_runs')
      .select('id, site_id, status, kind, project_id, archived_at, repo_owner, repo_name, issue_number')
      .eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: 'not found' });
    if (run.kind === 'interactive') return res.status(409).json({ error: 'interactive sessions have no PR to merge' });
    if (run.archived_at) return res.status(409).json({ error: 'run is archived' });
    if (['merged', 'closed', 'cancelled'].includes(run.status)) return res.status(409).json({ error: `run is ${run.status}` });
    // A PR only exists once the run has reached one of these states; anything earlier has nothing to merge.
    if (!['pr_open', 'watching', 'changes_requested'].includes(run.status)) return res.status(409).json({ error: 'no open PR to merge' });
    const project = await getProject(supabase, run.project_id);
    if (!project?.githubToken) return res.status(400).json({ error: 'project has no GitHub credential' });
    let result;
    try {
      result = await mergeRunPrs(supabase, run, project);
    } catch (e) {
      logger?.warn?.('se: manual merge failed', { error: String(e) });
      return res.status(500).json({ error: 'merge failed' });
    }
    // Finalize exactly as the auto path: pr-monitor closes the issue / archives the run / frees the next
    // slot once all PRs are merged. Only worth a nudge when something actually merged.
    if (result.merged >= 1) {
      try { await enqueueJob?.('se', 'software-engineer:pr-monitor', { runId: run.id }); }
      catch (e) { logger?.warn?.('se: enqueue pr-monitor failed', { error: String(e) }); }
    }
    res.json({ merged: result.merged, held: result.held, results: result.results });
  });

  router.post('/runs/:id/archive', async (req, res) => {
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const { error } = await supabase.from('se_runs').update({ archived_at: new Date().toISOString() }).eq('id', id);
    if (error) return res.status(500).json({ error: 'archive failed' });
    await dispatchFor(id);   // freed a slot → promote the next queued run
    res.json({ ok: true });
  });
  router.post('/runs/:id/unarchive', async (req, res) => {
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const { error } = await supabase.from('se_runs').update({ archived_at: null }).eq('id', id);
    if (error) return res.status(500).json({ error: 'unarchive failed' });
    res.json({ ok: true });
  });

  // ── Interactive engineers — manually start a live pair-programming session on a project ─────
  // Creates a kind='interactive' run (no issue, no pipeline) directly as 'running' and dispatches the
  // interactive worker, which opens the project's workspace and runs one persistent chat session until
  // it is closed (explicitly, or by an idle / wall-clock cap). Bounded by a per-project cap that is
  // separate from the issue pipeline pool. The admin then chats via the normal /runs/:id/message path.
  router.post('/engineers/interactive', async (req, res) => {
    if (!rateLimit(`se-admin:interactive:${clientIp(req)}`, 30, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    const projectId = String(req.body?.project_id ?? '');
    if (!UUID.test(projectId)) return res.status(400).json({ error: 'project_id required' });
    const proj = await getProject(supabase, projectId);
    if (!proj) return res.status(404).json({ error: 'project not found' });
    if (!proj.intakeEnabled) return res.status(409).json({ error: 'project is disabled (kill switch)' });
    if (!proj.githubToken) return res.status(400).json({ error: 'project has no GitHub credential' });

    const cap = Math.max(1, proj.maxInteractiveEngineers ?? 1);
    const { count } = await supabase.from('se_runs').select('*', { count: 'exact', head: true })
      .eq('project_id', projectId).eq('kind', 'interactive').is('archived_at', null).eq('status', 'running');
    if ((count ?? 0) >= cap) return res.status(409).json({ error: `interactive session limit reached (${cap})` });

    const branch = `agent/interactive-${randomUUID().slice(0, 8)}`;
    const name = INTERACTIVE_NAMES[Math.floor((count ?? 0)) % INTERACTIVE_NAMES.length];
    const { data: run, error } = await supabase.from('se_runs').insert({
      site_id: proj.siteId, project_id: projectId, kind: 'interactive',
      instance_id: process.env.SE_INSTANCE_ID || 'default',
      repo_owner: proj.issuesRepoOwner || 'interactive', repo_name: proj.issuesRepoName || 'session',
      issue_number: null, title: 'Interactive session',
      labeller: authorOf(req), status: 'running', current_phase: 'interactive',
      branch_name: branch, engineer_name: name,
    }).select('id').single();
    if (error || !run) {
      logger?.warn?.('se: start interactive failed', { error: String(error?.message ?? error) });
      return res.status(500).json({ error: 'create failed' });
    }
    try { await enqueuePhase({ enqueueJob }, run.id, 'interactive'); }
    catch (e) { logger?.warn?.('se: enqueue interactive failed', { error: String(e) }); }
    res.status(201).json({ runId: run.id });
  });

  // ── Issues — aggregate open issues from each project's issues repo + correlate with runs ───
  router.get('/issues', async (req, res) => {
    let pq = supabase.from('se_projects').select('id, name, avatar_emoji, issues_repo_owner, issues_repo_name');
    if (req.query.project && UUID.test(String(req.query.project))) pq = pq.eq('id', String(req.query.project));
    const { data: projects } = await pq;
    const { data: runs } = await supabase.from('se_runs')
      .select('id, repo_owner, repo_name, issue_number, status, engineer_name, archived_at, pr_url')
      .order('created_at', { ascending: false }).limit(500);
    const runMap = new Map();
    for (const r of runs ?? []) { const k = `${r.repo_owner}/${r.repo_name}#${r.issue_number}`; if (!runMap.has(k)) runMap.set(k, r); }
    const issues = [];
    for (const p of projects ?? []) {
      if (!p.issues_repo_owner || !p.issues_repo_name) continue;
      const proj = await getProject(supabase, p.id);
      if (!proj?.githubToken) continue;
      let list = [];
      try { list = await githubClient(proj.githubToken).listIssues(p.issues_repo_owner, p.issues_repo_name, 'open'); } catch { continue; }
      for (const iss of list ?? []) {
        if (iss.pull_request) continue;
        const labels = (iss.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);
        const run = runMap.get(`${p.issues_repo_owner}/${p.issues_repo_name}#${iss.number}`) ?? null;
        issues.push({
          project: { id: p.id, name: p.name, avatar_emoji: p.avatar_emoji },
          repo: `${p.issues_repo_owner}/${p.issues_repo_name}`, number: iss.number, title: iss.title, url: iss.html_url,
          labels, agent: labels.some((l) => l.startsWith('agent:')), updated_at: iss.updated_at,
          run: run ? { id: run.id, status: run.status, engineer_name: run.engineer_name, pr_url: run.pr_url, archived: !!run.archived_at } : null,
        });
      }
    }
    issues.sort((a, b) => (Number(b.agent) - Number(a.agent)) || String(b.updated_at).localeCompare(String(a.updated_at)));
    res.json({ issues });
  });

  // Create an issue on a project's issues repo (via the project PAT — reporter needs no GitHub
  // account). If assign_to_agent, add the trigger label AND directly create + dispatch the run.
  router.post('/issues', async (req, res) => {
    const projectId = String(req.body?.project_id ?? '');
    const title = sanitize(req.body?.title);
    if (!UUID.test(projectId) || !title) return res.status(400).json({ error: 'project_id + title required' });
    const proj = await getProject(supabase, projectId);
    if (!proj?.githubToken || !proj.issuesRepoOwner || !proj.issuesRepoName) return res.status(400).json({ error: 'project has no issues repo or token' });
    let body = req.body?.body != null ? String(req.body.body).slice(0, 60000) : '';
    // Attachments (pasted screenshots) — already uploaded to the public `media` bucket by the client.
    // Validate each URL against the host allowlist (defense in depth: the agent's download path
    // allowlists too) and append them as markdown so GitHub renders them inline in the issue.
    // Keep the candidate count separately from the allowlisted set so the response can report how many
    // attachments were DROPPED. On a `*.localhost` dev deployment the client's public storage URL is
    // `http://…` (rejected by the https-only SSRF allowlist), so it never reaches the issue body; the
    // count lets the client warn instead of showing a silent success. See lib/attachments.ts.
    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments.slice(0, 8) : [];
    const candidateUrls = attachments
      .map((a: any) => (typeof a === 'string' ? a : a?.url))
      .filter((u: any) => typeof u === 'string' && u.length > 0);
    const validUrls = candidateUrls.filter((u: string) => isAllowedAttachmentUrl(u));
    const attachmentsDropped = candidateUrls.length - validUrls.length;
    if (validUrls.length) {
      body += `\n\n### Attachments\n` + validUrls.map((u: string, i: number) => `![screenshot-${i + 1}](${u})`).join('\n');
    }
    const assign = !!req.body?.assign_to_agent;
    const gh = githubClient(proj.githubToken);
    try {
      const created = await gh.createIssue(proj.issuesRepoOwner, proj.issuesRepoName, { title, body, labels: assign ? [proj.triggerLabel] : [] });
      let runId = null;
      if (assign) {
        const { data: run } = await supabase.from('se_runs').insert({
          site_id: proj.siteId, project_id: projectId, instance_id: process.env.SE_INSTANCE_ID || 'default',
          repo_owner: proj.issuesRepoOwner, repo_name: proj.issuesRepoName, issue_number: created.number,
          title, labeller: authorOf(req), status: 'queued', current_phase: 'intake',
        }).select('id').single();
        runId = run?.id ?? null;
        await dispatchProject(supabase, { enqueueJob }, projectId);
      }
      res.status(201).json({ number: created.number, url: created.html_url, runId, attachmentsAttached: validUrls.length, attachmentsDropped });
    } catch (e) {
      logger?.warn?.('se: create issue failed', { error: String(e) });
      res.status(500).json({ error: 'create failed' });
    }
  });

  // ── Setup: brands + Projects + their repos ────────────────────────────────
  router.get('/brands', async (_req, res) => {
    const { data } = await supabase.from('sites').select('id, name').order('name');
    res.json({ brands: data ?? [] });
  });

  router.get('/projects', async (req, res) => {
    let q = supabase.from('se_projects').select(PROJECT_MASKED).order('name');
    if (req.query.site && UUID.test(String(req.query.site))) q = q.eq('site_id', String(req.query.site));
    const { data } = await q;
    res.json({ projects: data ?? [] });
  });

  router.post('/projects', async (req, res) => {
    const siteId = String(req.body?.site_id ?? '');
    const name = sanitize(req.body?.name);
    if (!UUID.test(siteId) || !name) return res.status(400).json({ error: 'site_id + name required' });
    const { data, error } = await supabase.from('se_projects').insert({
      site_id: siteId, name, description: sanitize(req.body?.description), avatar_emoji: sanitize(req.body?.avatar_emoji),
    }).select('id').single();
    if (error || !data) return res.status(500).json({ error: 'create failed' });
    res.status(201).json({ id: data.id });
  });

  router.get('/projects/:id', async (req, res) => {
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const { data } = await supabase.from('se_projects').select(PROJECT_MASKED).eq('id', id).maybeSingle();
    if (!data) return res.status(404).json({ error: 'not found' });
    res.json({ project: data });
  });

  router.put('/projects/:id', async (req, res) => {
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const b = req.body ?? {};
    const patch: any = {};
    for (const k of [
      'github_token_kind', 'github_app_installation_id', 'model_cred_kind', 'model', 'autonomy_mode',
      'intake_enabled', 'max_concurrent_engineers', 'max_interactive_engineers', 'max_code_repos_per_run',
      'monthly_token_budget', 'per_run_token_ceiling', 'per_run_wallclock_minutes',
    ]) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    for (const k of ['name', 'description', 'avatar_emoji', 'commit_author_name', 'commit_author_email',
      'issues_repo_owner', 'issues_repo_name', 'trigger_label', 'primary_instance_id']) {
      if (b[k] !== undefined) patch[k] = sanitize(b[k]);
    }
    if (b.name !== undefined && !patch.name) return res.status(400).json({ error: 'name cannot be empty' });
    if (Array.isArray(b.allowed_labellers)) patch.allowed_labellers = b.allowed_labellers.map(String);
    if (b.github_token) {
      const s = sealToken(String(b.github_token));
      patch.github_token_ciphertext = s.ciphertext; patch.github_token_last4 = s.last4; patch.github_health = 'unknown';
      patch.github_user_login = null; patch.github_user_id = null; patch.github_user_name = null; // re-derive owner
    }
    if (b.model_cred) {
      const s = sealToken(String(b.model_cred));
      patch.model_cred_ciphertext = s.ciphertext; patch.model_cred_last4 = s.last4; patch.model_health = 'unknown';
    }
    // §10: MCP server config. Accept an object/JSON string → validate shape → seal. '' or null clears.
    if (b.mcp_config !== undefined) {
      if (b.mcp_config === null || b.mcp_config === '') {
        patch.mcp_config_ciphertext = null;
      } else {
        let cfg = b.mcp_config;
        try { if (typeof cfg === 'string') cfg = JSON.parse(cfg); } catch { return res.status(400).json({ error: 'mcp_config must be valid JSON' }); }
        const raw = cfg?.servers ?? cfg;
        // Reject any local-exec (stdio) shape — only remote http/sse servers are permitted. Sealing a
        // `{ command, args, env }` server would be arbitrary root code execution in the runner (§10 RCE guard).
        let servers: Record<string, unknown>;
        try { servers = assertRemoteMcpServers(raw); }
        catch (e: any) { return res.status(400).json({ error: String(e?.message || 'mcp_config invalid — only http/sse servers with an http(s) url are allowed') }); }
        patch.mcp_config_ciphertext = sealToken(JSON.stringify({ servers })).ciphertext;
      }
    }
    const { error } = await supabase.from('se_projects').update(patch).eq('id', id);
    if (error) return res.status(500).json({ error: 'save failed' });
    res.json({ ok: true });
  });

  router.delete('/projects/:id', async (req, res) => {
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    await supabase.from('se_projects').delete().eq('id', id);
    res.json({ ok: true });
  });

  router.get('/projects/:id/repos', async (req, res) => {
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const { data } = await supabase.from('se_repos').select('*').eq('project_id', id).order('repo_owner');
    res.json({ repos: data ?? [] });
  });

  router.post('/projects/:id/repos', async (req, res) => {
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const owner = String(req.body?.repo_owner ?? '').trim();
    const name = String(req.body?.repo_name ?? '').trim();
    if (!owner || !name) return res.status(400).json({ error: 'owner + name required' });
    const { data: proj } = await supabase.from('se_projects').select('site_id').eq('id', id).maybeSingle();
    if (!proj) return res.status(404).json({ error: 'project not found' });
    const { error } = await supabase.from('se_repos').insert({ site_id: proj.site_id, project_id: id, repo_owner: owner, repo_name: name });
    if (error) return res.status(409).json({ error: 'repo already mapped to a project, or insert failed' });
    res.status(201).json({ ok: true });
  });

  router.patch('/projects/:id/repos/:repoId', async (req, res) => {
    const { id, repoId } = req.params;
    if (!UUID.test(id) || !UUID.test(repoId)) return res.status(400).json({ error: 'bad id' });
    const patch: any = {};
    if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
    if (req.body?.write_mode === 'writable' || req.body?.write_mode === 'read_only') patch.write_mode = req.body.write_mode;
    if (req.body?.base_branch !== undefined) patch.base_branch = sanitize(req.body.base_branch);
    const { error } = await supabase.from('se_repos').update(patch).eq('id', repoId).eq('project_id', id);
    if (error) return res.status(500).json({ error: 'update failed' });
    res.json({ ok: true });
  });

  router.delete('/projects/:id/repos/:repoId', async (req, res) => {
    const { id, repoId } = req.params;
    if (!UUID.test(id) || !UUID.test(repoId)) return res.status(400).json({ error: 'bad id' });
    await supabase.from('se_repos').delete().eq('id', repoId).eq('project_id', id);
    res.json({ ok: true });
  });
}
