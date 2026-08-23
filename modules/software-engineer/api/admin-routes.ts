// @ts-nocheck — express + supabase resolved at module-host install time.
/**
 * Admin API (JWT + is_admin gated by the platform for this prefix). Runs board + run detail, the
 * interactive control surface (chat into a live run, override, cancel), run archiving, and Setup:
 * PROJECTS — each project holds ALL credentials (git PAT + Claude model cred), its repos, shared
 * memory, policy, and a concurrency cap. Engineers are ephemeral (one per run, run.engineer_name).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { encodeEnvLabel, parseEnvLabel, envTierCheck } from '../lib/env-label.js';
import { ingestEnvEvents } from '../lib/env-events.js';
import { publishInput } from '../lib/input-channel.js';
import { sealToken, getProject, getCodeRepos } from '../lib/credentials.js';
import { githubClient } from '../lib/github.js';
import { mergeRunPrs } from '../lib/merge-prs.js';
import { dispatchProject } from '../lib/dispatch.js';
import { enqueuePhase } from '../lib/enqueue.js';
import { assertRemoteMcpServers } from '../lib/mcp.js';
import { parseSkillsConfig } from '../lib/skills.js';
import { normalizeModel } from '../lib/model-select.js';
import { isAllowedAttachmentUrl } from '../lib/attachments.js';
import { rateLimit, clientIp } from '../lib/rate-limit.js';
import { classifyPr, summarizeChecks, summarizeReviews } from '../lib/pr-status.js';
import { connectExternalPr } from '../lib/connect-pr.js';
import { runTriageTurn } from '../lib/triage.js';
import { dispatchTriageTurn } from '../lib/triage-dispatch.js';
import { redactToken } from '../lib/git.js';
import { readLiveMemory, readPendingMemory, approveMemory, rejectMemory, listPendingSpecs, approveSpec, rejectSpec, listMemorySources, linkMemorySource, unlinkMemorySource } from '../lib/memory.js';
import { syncMemoryToRepo } from '../lib/memory-git.js';
import { computeSpendOverview, computeModelUsage } from '../lib/cost.js';
import { classifyDecision, decisionTextFor, blockSummaryFor } from '../lib/decision-kind.js';
import { createOrSupersedeDecision, resumeRunForDecision, approveArchitecture, ARCHITECTURE_DECISION_OPTIONS } from '../lib/decisions.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Allowlist of valid se_runs.status values (mirrors the CHECK constraint, widened by migrations 015
// and 016 to add the architecture-review flow's two statuses, and by 017/018 to add the manual PR
// submit gate and the human spec-approval gate). The /runs board accepts a comma-separated status set
// from the Overview KPI tiles or the board's own status filter chips; every value is validated
// against this set so a caller can't smuggle an arbitrary string into the filter.
const RUN_STATUSES = new Set([
  'queued', 'running', 'blocked', 'failed', 'pr_open', 'watching', 'changes_requested', 'merged', 'closed', 'cancelled',
  'awaiting_architecture', 'architecture_in_review', 'ready_to_submit', 'awaiting_spec',
]);

const PROJECT_MASKED =
  'id, site_id, name, description, avatar_emoji,' +
  ' issues_repo_owner, issues_repo_name, trigger_label, primary_instance_id, max_code_repos_per_run,' +
  ' github_token_last4, github_token_kind, github_app_installation_id, github_health, github_checked_at,' +
  ' github_user_login, github_user_id, github_user_name,' +
  ' model_cred_last4, model_cred_kind, model, model_health, model_checked_at,' +
  ' phase_models, escalation_model, openai_cred_last4,' +
  ' commit_author_name, commit_author_email,' +
  ' allowed_labellers, intake_enabled, autonomy_mode, pr_submit_mode, max_concurrent_engineers, max_interactive_engineers,' +
  ' has_mcp_config, skills,' +
  ' process_repo, process_path, process_ref, architecture_repo, architecture_ref, tracker_url_template,' +
  ' gates, approvers, refine_budget,' +
  ' credential_mode, committing_pat_last4, commenting_pat_last4, pull_request_pat_last4, coding_agent_model_last4,' +
  ' slack_webhook_last4,' +
  ' monthly_token_budget, per_run_token_ceiling, per_run_wallclock_minutes, per_run_cost_ceiling_usd, created_at, updated_at';

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

  // Advance authorization (§ phase gates). Every action that spends implementation tokens or uses the
  // PAT's write/push/merge power (approve spec, finalize/approve architecture, submit, merge) is an
  // Advance action. A project with a NON-EMPTY approver list restricts these to those gatewaze users,
  // independent of platform admin, so a super-admin who is not on the list is refused. An EMPTY list is
  // unrestricted (any admin), which preserves the behavior of projects that never configure gating.
  // Returns true when the request was DENIED (a 403 has been sent); the caller returns immediately.
  const denyIfNotApprover = async (req, res, run) => {
    if (process.env.GATEWAZE_TEST_DISABLE_AUTH === '1') return false;
    const { data: proj } = await supabase.from('se_projects').select('approvers').eq('id', run.project_id).maybeSingle();
    const list = Array.isArray(proj?.approvers) ? proj.approvers.map(String) : [];
    const userId = authorOf(req);
    if (list.length === 0 || (userId && list.includes(String(userId)))) return false;
    // Record the refusal for audit (kind='gate' is allowed by se_events' CHECK).
    try { await supabase.from('se_events').insert({ run_id: run.id, site_id: run.site_id, phase: run.current_phase ?? null, seq: 0, kind: 'gate', payload: { refused: 'advance', route: String(req.path ?? ''), user: userId } }); } catch { /* best-effort */ }
    res.status(403).json({ error: { code: 'not_approver', message: 'You are not an approver for this project.' } });
    return true;
  };

  // ── Staging self-update (§staging box) ─────────────────────────────────────
  // Deployment-optional: enabled only where the operator bind-mounts a
  // /staging-control dir into the api container (the staging compose overlay).
  // POST drops request.json; a HOST-side agent (staging-updater.sh, outside
  // this container — it needs git + docker on the host) watches the dir, runs
  // a drain-aware update cycle (SE queue drains between agent phases; no run
  // is killed), and streams status.json back for GET to serve. SUPER-ADMIN
  // only — stricter than the router-level admin gate — because pressing it
  // restarts every service in the deployment.
  const STAGING_CONTROL = '/staging-control';
  const stagingStatus = () => {
    let status = null;
    try { status = JSON.parse(readFileSync(`${STAGING_CONTROL}/status.json`, 'utf8')); } catch { /* none yet */ }
    const pending = existsSync(`${STAGING_CONTROL}/request.json`) || existsSync(`${STAGING_CONTROL}/request.processing`);
    return { available: true, pending, status };
  };

  router.get('/staging-update/status', async (req, res) => {
    if (!rateLimit(`se-admin:staging-status:${clientIp(req)}`, 120, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    if (!existsSync(STAGING_CONTROL)) return res.json({ available: false });
    res.json(stagingStatus());
  });

  router.post('/staging-update', async (req, res) => {
    // Tight per-IP limit: this route writes a control file that restarts every
    // service in the deployment, so cap it hard (defense in depth on top of the
    // super-admin gate + the in-progress 409 guard below).
    if (!rateLimit(`se-admin:staging-update:${clientIp(req)}`, 10, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    if (!existsSync(STAGING_CONTROL)) {
      return res.status(404).json({ error: { code: 'not_available', message: 'This deployment has no staging-update channel' } });
    }
    // CSRF hardening (security review): the platform's requireJwt accepts a
    // Supabase auth COOKIE as a fallback, and a cross-site form POST sends
    // cookies without CORS stopping it. This route restarts the entire
    // deployment, so require the explicit Bearer header — the admin SPA
    // always sends it; only cookie-only (potentially forged) requests lose.
    if (!String(req.headers.authorization ?? '').startsWith('Bearer ')) {
      return res.status(403).json({ error: { code: 'bearer_required', message: 'Explicit Authorization header required for this action' } });
    }
    // Escalate beyond the router-level gate: super_admin only.
    const userId = authorOf(req);
    const { data: prof } = await supabase
      .from('admin_profiles').select('role').eq('user_id', userId).eq('is_active', true).maybeSingle();
    if (prof?.role !== 'super_admin') {
      return res.status(403).json({ error: { code: 'forbidden', message: 'Super-admin access required' } });
    }
    const cur = stagingStatus();
    if (cur.pending || ['pulling', 'restarting-services', 'draining-se', 'restarting-se-runner', 'rebuilding-admin'].includes(cur.status?.state)) {
      return res.status(409).json({ error: { code: 'update_in_progress', message: 'An update is already in progress' }, ...cur });
    }
    writeFileSync(`${STAGING_CONTROL}/request.json`, JSON.stringify({ requested_at: new Date().toISOString(), requested_by: userId }));
    logger?.info?.('se: staging update requested', { userId });
    res.status(202).json(stagingStatus());
  });

  // ── PR test environment ────────────────────────────────────────────────────
  // Same control-channel model as staging-update, but the request CARRIES
  // CONTENT (a PR set), so both sides validate it: here a strict repo enum +
  // integer PR numbers; the host agent (staging-test-env.sh) re-validates and
  // resolves PRs via numeric refs/pull/N/head only — no branch names, no
  // request string ever reaches a shell. Deploying replaces the single test
  // env slot per PROFILE; the test stack never runs se-runner.
  //
  // Profiles: each profile is a separate env slot with its own host-agent
  // daemon, request/status file pair, GitHub org and repo allowlist. `prs` is an ORDERED
  // list and may repeat a repo — the host agent merges same-repo PRs onto
  // origin/main locally, in order (merge-queue semantics); a merge conflict
  // surfaces as status state:"error" naming the conflicting PR. The profile is
  // validated as a literal key BEFORE any filename is derived from it.
  const TEST_ENV_PROFILES = {
    gatewaze: { org: 'gatewaze', requestFile: 'test-env-request.json', statusFile: 'test-status.json', repos: ['gatewaze', 'gatewaze-modules', 'lf-gatewaze-modules'], maxPrs: 6 },
    lfx: { org: 'linuxfoundation', requestFile: 'lfx-env-request.json', statusFile: 'lfx-status.json', repos: ['lfx-self-serve', 'lfx-v2-helm', 'lfx-v2-email-service', 'lfx-v2-campaign-service', 'lfx-v2-mailing-list-service', 'lfx-v2-newsletter-service', 'lfx-v2-committee-service'], maxPrs: 8 },
  } as const;
  // Strict enum gate (security: the profile selects control-channel FILENAMES —
  // never let a non-literal value near a path). Missing/empty → 'gatewaze' for
  // back-compat with pre-profile clients; anything else unknown → null (422).
  const testEnvProfileOf = (raw: unknown): keyof typeof TEST_ENV_PROFILES | null => {
    if (raw === undefined || raw === null || raw === '') return 'gatewaze';
    const s = String(raw);
    return Object.prototype.hasOwnProperty.call(TEST_ENV_PROFILES, s) ? (s as keyof typeof TEST_ENV_PROFILES) : null;
  };
  const TEST_ENV_ACTIVE = new Set([
    'preparing-worktrees', 'cloning-db', 'cloning-storage', 'building', 'starting', 'tearing-down',
    // lfx-profile cycle states (same busy semantics)
    'deploying-helm', 'building-services', 'building-app', 'starting-app',
  ]);
  const testEnvStatus = (profile: keyof typeof TEST_ENV_PROFILES) => {
    const { requestFile, statusFile } = TEST_ENV_PROFILES[profile];
    let status = null;
    try { status = JSON.parse(readFileSync(`${STAGING_CONTROL}/${statusFile}`, 'utf8')); } catch { /* none yet */ }
    const pending = existsSync(`${STAGING_CONTROL}/${requestFile}`) || existsSync(`${STAGING_CONTROL}/${requestFile.replace(/\.json$/, '.processing')}`);
    return { available: true, profile, pending, status };
  };
  const requireSuperAdminBearer = async (req, res) => {
    if (!String(req.headers.authorization ?? '').startsWith('Bearer ')) {
      res.status(403).json({ error: { code: 'bearer_required', message: 'Explicit Authorization header required for this action' } });
      return false;
    }
    const userId = authorOf(req);
    const { data: prof } = await supabase
      .from('admin_profiles').select('role').eq('user_id', userId).eq('is_active', true).maybeSingle();
    if (prof?.role !== 'super_admin') {
      res.status(403).json({ error: { code: 'forbidden', message: 'Super-admin access required' } });
      return false;
    }
    return true;
  };

  router.get('/test-env/status', async (req, res) => {
    if (!rateLimit(`se-admin:test-env-status:${clientIp(req)}`, 120, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    if (!existsSync(STAGING_CONTROL)) return res.json({ available: false });
    const profile = testEnvProfileOf(req.query.profile);
    if (!profile) return res.status(422).json({ error: { code: 'invalid_input', message: 'Unknown test-env profile' } });
    res.json(testEnvStatus(profile));
  });

  router.post('/test-env/deploy', async (req, res) => {
    if (!rateLimit(`se-admin:test-env:${clientIp(req)}`, 10, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    if (!existsSync(STAGING_CONTROL)) {
      return res.status(404).json({ error: { code: 'not_available', message: 'This deployment has no test-env channel' } });
    }
    if (!(await requireSuperAdminBearer(req, res))) return;
    const profile = testEnvProfileOf(req.body?.profile);
    if (!profile) return res.status(422).json({ error: { code: 'invalid_input', message: 'Unknown test-env profile' } });
    const { repos, maxPrs, requestFile } = TEST_ENV_PROFILES[profile];
    const allowed = new Set(repos);
    const raw = Array.isArray(req.body?.prs) ? req.body.prs : [];
    // Mainline deploy: an EXPLICIT `mainline: true` (strict boolean) allows an empty prs list — the
    // host agents treat empty prs as "deploy plain origin/main". Without the flag an empty list is
    // still a caller mistake (an accidentally-empty selection must not wipe the env), so it 422s.
    // With a non-empty list the flag changes nothing — the PRs are validated and forwarded as ever.
    const mainline = req.body?.mainline === true;
    // Live mode (Tier 1): `live: true` asks the host agent to keep tracking
    // origin/main + the merged PR heads after the deploy and re-merge/refresh
    // the env on every push. Strict boolean — absent defaults to false, any
    // non-boolean value is rejected (the host agent re-validates the same way).
    const live = req.body?.live;
    if (live !== undefined && typeof live !== 'boolean') {
      return res.status(422).json({ error: { code: 'invalid_input', message: 'live must be a boolean' } });
    }
    // Fresh data: `fresh: true` asks the host agent to wipe the env's data
    // stores and rerun the full seed after the deploy (lfx profile: newsletter
    // DB schema drop + mockdata reseed). Strict boolean, validated exactly
    // like `live` — absent defaults to false, any non-boolean is rejected,
    // and the host agent re-validates the same way. The lfx agent also
    // treats ANY deploy starting from a torn-down env as fresh regardless of
    // this flag; the gatewaze agent currently ignores it (its deploys always
    // clone data fresh).
    const fresh = req.body?.fresh;
    if (fresh !== undefined && typeof fresh !== 'boolean') {
      return res.status(422).json({ error: { code: 'invalid_input', message: 'fresh must be a boolean' } });
    }
    if ((raw.length === 0 && !mainline) || raw.length > maxPrs) {
      return res.status(422).json({ error: { code: 'invalid_input', message: `prs must be an ordered array of 1..${maxPrs} entries (or empty with mainline: true)` } });
    }
    // Order is preserved VERBATIM into the request file. Repeated repos are
    // allowed (same-repo PRs merge sequentially on the host); an exact
    // duplicate {repo,number} pair is a caller mistake, so reject it.
    const prs = [];
    for (const p of raw) {
      const repo = String(p?.repo ?? '');
      const number = Number(p?.number);
      if (!allowed.has(repo) || !Number.isInteger(number) || number < 1 || number > 99999) {
        return res.status(422).json({ error: { code: 'invalid_input', message: `Bad PR entry: ${repo}#${p?.number}` } });
      }
      if (prs.some((x) => x.repo === repo && x.number === number)) {
        return res.status(422).json({ error: { code: 'invalid_input', message: `Duplicate PR entry: ${repo}#${number}` } });
      }
      prs.push({ repo, number });
    }
    const cur = testEnvStatus(profile);
    if (cur.pending || TEST_ENV_ACTIVE.has(cur.status?.state)) {
      return res.status(409).json({ error: { code: 'busy', message: 'A test-env operation is already in progress' }, ...cur });
    }
    writeFileSync(`${STAGING_CONTROL}/${requestFile}`,
      JSON.stringify({ action: 'deploy', prs, live: live === true, fresh: fresh === true, requested_at: new Date().toISOString(), requested_by: authorOf(req) }));
    logger?.info?.('se: test-env deploy requested', { profile, prs, mainline, live: live === true, fresh: fresh === true });
    res.status(202).json(testEnvStatus(profile));
  });

  // Cross-repo related PRs for a deployable PR: agent runs reuse ONE head
  // branch name across the repos they touch, so "same head branch, open, in
  // another deployable repo" is the dependency heuristic the deploy UI
  // pre-selects. Read-only (standard admin gate suffices); uses the project's
  // PAT like every other GitHub read here.
  router.get('/test-env/related', async (req, res) => {
    if (!rateLimit(`se-admin:test-env-related:${clientIp(req)}`, 60, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    const profile = testEnvProfileOf(req.query.profile);
    if (!profile) return res.status(422).json({ error: { code: 'invalid_input', message: 'Unknown test-env profile' } });
    const { org, repos: deployable } = TEST_ENV_PROFILES[profile];
    const projectId = String(req.query.project_id ?? '');
    const repo = String(req.query.repo ?? '');
    const number = Number(req.query.number);
    if (!UUID.test(projectId) || !deployable.includes(repo) || !Number.isInteger(number) || number < 1 || number > 99999) {
      return res.status(422).json({ error: { code: 'invalid_input', message: 'project_id + deployable repo + PR number required' } });
    }
    const proj = await getProject(supabase, projectId);
    if (!proj?.githubToken) return res.status(404).json({ error: { code: 'not_found', message: 'Project or its GitHub credential not found' } });
    const gh = githubClient(proj.githubToken);
    try {
      const pull = await gh.getPullRequest(org, repo, number);
      const branch = String(pull?.head?.ref ?? '');
      const headOwner = String(pull?.head?.repo?.owner?.login ?? org);
      if (!branch) return res.json({ branch: null, related: [] });
      const related = [];
      for (const other of deployable) {
        if (other === repo) continue;
        try {
          const matches = await gh.listOpenPullsByHead(org, other, headOwner, branch);
          for (const m of matches ?? []) {
            related.push({ repo: other, number: m.number, title: m.title, url: m.html_url, branch });
          }
        } catch { /* repo unreadable with this PAT — skip */ }
      }
      res.json({ branch, related });
    } catch (e) {
      logger?.warn?.('se: test-env related lookup failed', { error: String(e) });
      res.status(502).json({ error: { code: 'github_error', message: 'Could not look up related PRs' } });
    }
  });

  router.post('/test-env/teardown', async (req, res) => {
    if (!rateLimit(`se-admin:test-env:${clientIp(req)}`, 10, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    if (!existsSync(STAGING_CONTROL)) {
      return res.status(404).json({ error: { code: 'not_available', message: 'This deployment has no test-env channel' } });
    }
    if (!(await requireSuperAdminBearer(req, res))) return;
    const profile = testEnvProfileOf(req.body?.profile);
    if (!profile) return res.status(422).json({ error: { code: 'invalid_input', message: 'Unknown test-env profile' } });
    const cur = testEnvStatus(profile);
    if (cur.pending || TEST_ENV_ACTIVE.has(cur.status?.state)) {
      return res.status(409).json({ error: { code: 'busy', message: 'A test-env operation is already in progress' }, ...cur });
    }
    writeFileSync(`${STAGING_CONTROL}/${TEST_ENV_PROFILES[profile].requestFile}`,
      JSON.stringify({ action: 'teardown', requested_at: new Date().toISOString(), requested_by: authorOf(req) }));
    logger?.info?.('se: test-env teardown requested', { profile });
    res.status(202).json(testEnvStatus(profile));
  });

  // ── Hostname-keyed multi test environments (spec §4.3, phase 2) ────────────
  // ADDITIONAL lfx envs at {label}.pr-view.com, alongside the primary slot the
  // routes above manage. Same control-channel model: the request CARRIES a
  // spec, so both sides validate — here with the TS twin of the host's
  // grammar (lib/env-label.ts, pinned against lfx-envlabel.py), and the host
  // agent (staging-multienv.sh) re-validates with the Python original before
  // anything is deployed. The request FILENAME is always the label THIS
  // server computed via encodeEnvLabel — user input never names a file. The
  // label IS the env identity (canonical encode of the spec).
  const ENVS_DIR = `${STAGING_CONTROL}/envs`;
  const ENV_REQS_DIR = `${ENVS_DIR}/requests`;
  // Same shape gate the host agent applies before deriving anything from a
  // label (path-param rule). Grammar validation happens on top of this.
  const ENV_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,52}[a-z0-9])?$/;
  const ENV_CAP = 4; // spec §3.4 lfx cap — the host agent enforces it too (plus measured admission)
  const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
  const envPending = (label) =>
    existsSync(`${ENV_REQS_DIR}/${label}.request.json`) || existsSync(`${ENV_REQS_DIR}/${label}.request.json.processing`);
  // Registry labels = envs/<label>.json, excluding the .status/.k8s siblings.
  const envRegistryLabels = () => {
    let names = [];
    try { names = readdirSync(ENVS_DIR); } catch { return []; }
    return names
      .filter((n) => n.endsWith('.json') && !n.endsWith('.status.json') && !n.endsWith('.k8s.json') && !n.endsWith('.request.json'))
      .map((n) => n.slice(0, -5))
      .filter((l) => ENV_LABEL_RE.test(l) && l.startsWith('lfx--'));
  };
  const envEntry = (label) => {
    const registry = readJson(`${ENVS_DIR}/${label}.json`);
    const status = readJson(`${ENVS_DIR}/${label}.status.json`);
    return { label, registry, status, pending: envPending(label) };
  };
  // Validate a :label path param: shape first, then the grammar (b- slugs
  // parse; h- and malformed labels are rejected). Returns null when invalid.
  const envLabelParam = (raw) => {
    const label = String(raw ?? '');
    if (!ENV_LABEL_RE.test(label)) return null;
    return parseEnvLabel(label).error === null ? label : null;
  };

  router.get('/test-env/envs', async (req, res) => {
    if (!rateLimit(`se-admin:test-env-envs:${clientIp(req)}`, 120, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    if (!existsSync(ENVS_DIR)) return res.json({ available: false });
    const profile = req.query.profile === undefined || req.query.profile === '' ? 'lfx' : String(req.query.profile);
    if (profile !== 'lfx') return res.status(422).json({ error: { code: 'invalid_input', message: 'Only the lfx profile has hostname-keyed envs' } });
    // Observability ingest rides the poll (best-effort, never blocks the list).
    try { await ingestEnvEvents(supabase); } catch { /* best-effort */ }
    const labels = new Set(envRegistryLabels());
    // Queued creates for brand-new labels (request exists, registry not yet):
    // surface them so the Overview shows a "queued" card immediately.
    try {
      for (const n of readdirSync(ENV_REQS_DIR)) {
        const m = n.match(/^([a-z0-9-]+)\.request\.json(\.processing)?$/);
        if (m && ENV_LABEL_RE.test(m[1]) && m[1].startsWith('lfx--')) labels.add(m[1]);
      }
    } catch { /* no requests dir yet */ }
    res.json({ available: true, profile, cap: ENV_CAP, envs: [...labels].sort().map(envEntry) });
  });

  router.post('/test-env/envs', async (req, res) => {
    if (!rateLimit(`se-admin:test-env:${clientIp(req)}`, 10, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    if (!existsSync(ENVS_DIR)) {
      return res.status(404).json({ error: { code: 'not_available', message: 'This deployment has no multi-env channel' } });
    }
    if (!(await requireSuperAdminBearer(req, res))) return;
    // Spec entries: {repo, pr} or {repo, branch}. Everything is validated by
    // the encoder (repo against the alias table, pr 1..99999 integer, branch
    // against the safe-ref shape with no '..'); nothing user-supplied is used
    // before it validates.
    const rawSpec = req.body?.spec;
    if (!Array.isArray(rawSpec) || rawSpec.length < 1 || rawSpec.length > 8) {
      return res.status(422).json({ error: { code: 'invalid_input', message: 'spec must be an ordered array of 1..8 entries' } });
    }
    // Live mode defaults TRUE for hostname-keyed envs (host-agent default) —
    // strict boolean when present, same contract as the primary-slot routes.
    const live = req.body?.live;
    if (live !== undefined && typeof live !== 'boolean') {
      return res.status(422).json({ error: { code: 'invalid_input', message: 'live must be a boolean' } });
    }
    // TTL (phase 3 reaping): hours from last activity before the env is
    // reaped. Integer 1..168; default 3 (applied host-side when absent).
    const ttl = req.body?.ttl_hours;
    if (ttl !== undefined && (!Number.isInteger(ttl) || ttl < 1 || ttl > 168)) {
      return res.status(422).json({ error: { code: 'invalid_input', message: 'ttl_hours must be an integer between 1 and 168' } });
    }
    const spec = rawSpec.map((e) => {
      const repo = String(e?.repo ?? '');
      return 'branch' in (e ?? {}) ? { repo, branch: String(e.branch ?? '') } : { repo, pr: Number(e?.pr) };
    });
    const enc = encodeEnvLabel(spec);
    if (enc.error !== null) {
      return res.status(422).json({ error: { code: 'invalid_input', message: `Invalid env spec: ${enc.error}` } });
    }
    const tierErr = envTierCheck(spec);
    if (tierErr) return res.status(422).json({ error: { code: 'invalid_input', message: tierErr } });
    const label = enc.label;
    if (envPending(label)) {
      return res.status(409).json({ error: { code: 'busy', message: 'A request for this environment is already in progress' } });
    }
    const existing = readJson(`${ENVS_DIR}/${label}.json`);
    if (existing && existing.status !== 'reaped') {
      return res.status(409).json({ error: { code: 'exists', message: `Environment ${label} already exists — refresh or tear it down instead` }, label });
    }
    // Cap gate (reaped entries keep their registry file but hold no
    // resources, so they don't count). The host agent re-checks, plus its
    // measured memory/disk admission — this is just the fast client-side no.
    const active = envRegistryLabels().filter((l) => readJson(`${ENVS_DIR}/${l}.json`)?.status !== 'reaped');
    if (active.length >= ENV_CAP) {
      return res.status(409).json({ error: { code: 'cap_reached', message: `Environment cap reached (${ENV_CAP}) — tear one down first` } });
    }
    writeFileSync(`${ENV_REQS_DIR}/${label}.request.json`, JSON.stringify({
      action: 'create', spec, live: live !== false, ...(ttl !== undefined ? { ttl_hours: ttl } : {}),
      requested_at: new Date().toISOString(), requested_by: authorOf(req),
    }));
    logger?.info?.('se: multi-env create requested', { label, live: live !== false, ttl_hours: ttl ?? null });
    res.status(202).json({ label, ...envEntry(label) });
  });

  router.delete('/test-env/envs/:label', async (req, res) => {
    if (!rateLimit(`se-admin:test-env:${clientIp(req)}`, 10, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    if (!existsSync(ENVS_DIR)) {
      return res.status(404).json({ error: { code: 'not_available', message: 'This deployment has no multi-env channel' } });
    }
    if (!(await requireSuperAdminBearer(req, res))) return;
    const label = envLabelParam(req.params.label);
    if (!label) return res.status(422).json({ error: { code: 'invalid_input', message: 'Not a valid environment label' } });
    if (envPending(label)) {
      return res.status(409).json({ error: { code: 'busy', message: 'A request for this environment is already in progress' } });
    }
    writeFileSync(`${ENV_REQS_DIR}/${label}.request.json`,
      JSON.stringify({ action: 'teardown', requested_at: new Date().toISOString(), requested_by: authorOf(req) }));
    logger?.info?.('se: multi-env teardown requested', { label });
    res.status(202).json({ label, ...envEntry(label) });
  });

  router.post('/test-env/envs/:label/refresh', async (req, res) => {
    if (!rateLimit(`se-admin:test-env:${clientIp(req)}`, 10, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    if (!existsSync(ENVS_DIR)) {
      return res.status(404).json({ error: { code: 'not_available', message: 'This deployment has no multi-env channel' } });
    }
    if (!(await requireSuperAdminBearer(req, res))) return;
    const label = envLabelParam(req.params.label);
    if (!label) return res.status(422).json({ error: { code: 'invalid_input', message: 'Not a valid environment label' } });
    const registry = readJson(`${ENVS_DIR}/${label}.json`);
    if (!registry || !Array.isArray(registry.spec)) {
      return res.status(404).json({ error: { code: 'not_found', message: 'No such environment in the registry' } });
    }
    if (envPending(label)) {
      return res.status(409).json({ error: { code: 'busy', message: 'A request for this environment is already in progress' } });
    }
    // Redeploy from the registry's own spec (the exact branch refs live
    // there; the hostname slug is lossy). Verify the registry spec still
    // encodes to this label — a mismatched registry is corrupt, not a deploy.
    const enc = encodeEnvLabel(registry.spec);
    if (enc.error !== null || enc.label !== label) {
      return res.status(409).json({ error: { code: 'registry_mismatch', message: 'Registry spec does not encode to this label — refusing to redeploy' } });
    }
    writeFileSync(`${ENV_REQS_DIR}/${label}.request.json`, JSON.stringify({
      action: 'create', spec: registry.spec, live: registry.live !== false,
      ...(Number.isInteger(registry.ttl_hours) ? { ttl_hours: registry.ttl_hours } : {}),
      requested_at: new Date().toISOString(), requested_by: authorOf(req),
    }));
    logger?.info?.('se: multi-env refresh requested', { label });
    res.status(202).json({ label, ...envEntry(label) });
  });

  // Activity timeline + errors view for the Environments section — events
  // ingested from the box by ingestEnvEvents (see lib/env-events.ts).
  router.get('/test-env/env-events', async (req, res) => {
    if (!rateLimit(`se-admin:test-env-events:${clientIp(req)}`, 120, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    const limitRaw = Number(req.query.limit ?? 100);
    const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 500 ? limitRaw : 100;
    let q = supabase.from('se_env_events')
      .select('id, ts, kind, env_label, detail, meta')
      .order('ts', { ascending: false })
      .limit(limit);
    if (req.query.env !== undefined) {
      const env = envLabelParam(req.query.env);
      if (!env) return res.status(422).json({ error: { code: 'invalid_input', message: 'Not a valid environment label' } });
      q = q.eq('env_label', env);
    }
    if (req.query.kind !== undefined) {
      const kinds = String(req.query.kind).split(',').filter((k) => /^[a-z][a-z0-9_]{0,31}$/.test(k));
      if (kinds.length === 0) return res.status(422).json({ error: { code: 'invalid_input', message: 'Bad kind filter' } });
      q = q.in('kind', kinds);
    }
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: { code: 'query_failed', message: 'Could not load env events' } });
    res.json({ events: data ?? [] });
  });

  // ── Project memory: review + human approval (memory-poisoning gate) ────────
  // reflect writes proposed memory to a pending slot; it is NOT injected into
  // any run until an admin approves it here. All three routes are admin-gated
  // by the router.use above.
  router.get('/projects/:id/memory', async (req, res) => {
    const projectId = String(req.params.id);
    const project = await getProject(supabase, projectId);
    if (!project) return res.status(404).json({ error: { code: 'not_found', message: 'Project not found' } });
    const [live, pending, pendingSpecs] = await Promise.all([
      readLiveMemory(projectId), readPendingMemory(projectId), listPendingSpecs(projectId),
    ]);
    return res.json({ live, pending, hasPending: !!pending, pending_specs: pendingSpecs });
  });
  // Spec approval gate: a run's spec sits at specs-pending/ (never recallable) until approved —
  // automatically when its PR merges (pr-monitor), or here for runs that never merged.
  router.post('/projects/:id/specs/:issue/approve', async (req, res) => {
    const projectId = String(req.params.id);
    const issue = Number.parseInt(String(req.params.issue), 10);
    if (!Number.isInteger(issue) || issue <= 0) return res.status(400).json({ error: { code: 'invalid_input', message: 'Bad issue number' } });
    const project = await getProject(supabase, projectId);
    if (!project) return res.status(404).json({ error: { code: 'not_found', message: 'Project not found' } });
    const ok = await approveSpec(supabase, projectId, project.name, issue);
    if (!ok) return res.status(409).json({ error: { code: 'no_pending', message: 'No pending spec for that issue' } });
    return res.json({ approved: true });
  });
  router.post('/projects/:id/specs/:issue/reject', async (req, res) => {
    const projectId = String(req.params.id);
    const issue = Number.parseInt(String(req.params.issue), 10);
    if (!Number.isInteger(issue) || issue <= 0) return res.status(400).json({ error: { code: 'invalid_input', message: 'Bad issue number' } });
    const project = await getProject(supabase, projectId);
    if (!project) return res.status(404).json({ error: { code: 'not_found', message: 'Project not found' } });
    await rejectSpec(supabase, projectId, project.name, issue);
    return res.json({ rejected: true });
  });
  router.post('/projects/:id/memory/approve', async (req, res) => {
    const projectId = String(req.params.id);
    const project = await getProject(supabase, projectId);
    if (!project) return res.status(404).json({ error: { code: 'not_found', message: 'Project not found' } });
    const ok = await approveMemory(supabase, projectId, project.name);
    if (!ok) return res.status(409).json({ error: { code: 'no_pending', message: 'No pending memory to approve' } });
    // New information committed to memory → git-sync it to the project's memory repo. Fire-and-forget:
    // the git push must not block (or fail) the admin response.
    void syncMemoryToRepo(supabase, projectId, logger).catch(() => {});
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
    const [{ data, error }, spend] = await Promise.all([
      supabase.rpc('se_overview', { p_project: project }),
      computeSpendOverview(supabase, project),
    ]);
    if (error) {
      logger?.warn?.('se: overview failed', { error: String(error?.message ?? error) });
      return res.status(500).json({ error: 'overview failed' });
    }
    res.json({ ...(data ?? {}), ...(spend ? { spend } : {}) });
  });

  // Per-model spend, SUBAGENT-inclusive (from se_phases.model_usage via the se_model_usage RPC) — the
  // flat token columns miss the subagent sessions a phase fans out. ?project scopes it; ?days windows
  // it (default 7, clamped 1..365). Separate from /overview so the tab can lazy-load it on demand.
  router.get('/overview/model-usage', async (req, res) => {
    let project: string | null = null;
    if (req.query.project !== undefined && req.query.project !== '') {
      project = String(req.query.project);
      if (!UUID.test(project)) return res.status(400).json({ error: 'bad project' });
    }
    const days = Math.min(365, Math.max(1, Math.floor(Number(req.query.days)) || 7));
    const models = await computeModelUsage(supabase, project, days);
    res.json({ days, models });
  });

  // ── Decisions needed — every run parked waiting on a human, disambiguated + plain-language ─
  // (issue #49). Aggregates the human-gated statuses that used to be scattered across two separate
  // spec/architecture RunListSections plus an undifferentiated `blocked` bucket into one endpoint, so
  // the admin has one place to see everything waiting on them with a deep link to act on it.
  router.get('/overview/decisions', async (req, res) => {
    let project: string | null = null;
    if (req.query.project !== undefined && req.query.project !== '') {
      project = String(req.query.project);
      if (!UUID.test(project)) return res.status(400).json({ error: 'bad project' });
    }
    let q = supabase
      .from('se_runs')
      .select('id, project_id, repo_owner, repo_name, issue_number, title, status, error, retry_count, current_phase, cost_usd, created_at, updated_at, architecture_repo, architecture_path, architecture_commit_url, project:se_projects(name, avatar_emoji)')
      .is('archived_at', null)
      .in('status', ['awaiting_spec', 'awaiting_architecture', 'architecture_in_review', 'ready_to_submit', 'blocked'])
      .order('updated_at', { ascending: true })
      .limit(200);
    if (project) q = q.eq('project_id', project);
    const { data: runs, error } = await q;
    if (error) {
      logger?.warn?.('se: overview/decisions failed', { error: String(error?.message ?? error) });
      return res.status(500).json({ error: 'overview/decisions failed' });
    }
    const runIds = (runs ?? []).map((r) => r.id);
    const { data: prs } = runIds.length
      ? await supabase.from('se_run_prs').select('run_id, state').in('run_id', runIds)
      : { data: [] };
    const { data: gates } = runIds.length
      ? await supabase.from('se_gates').select('run_id, detail, created_at').eq('gate', 'adversarial_review').in('run_id', runIds).order('created_at', { ascending: false })
      : { data: [] };
    const byRun = {};
    for (const p of prs ?? []) (byRun[p.run_id] ??= []).push(p);
    const latestGateByRun = {};
    for (const g of gates ?? []) if (!latestGateByRun[g.run_id]) latestGateByRun[g.run_id] = g;
    // Prefer a PERSISTED se_decisions row over the synthetic classifyDecision() label (issue #52): once
    // a run reaches a blocking point that emits a decision, the panel should show the actual QUESTION
    // (and, for a choice decision, its answerable options) rather than a plain-language description
    // re-derived from live state. A run keeps showing here — as answered — for 15 minutes after an
    // answer that leaves it in a gated status (e.g. an architecture 'reject', which is terminal).
    const { data: persisted } = runIds.length
      ? await supabase.from('se_decisions')
          .select('id, run_id, question, kind, options, context, status, answer, answered_by, answered_at')
          .in('run_id', runIds).in('status', ['pending', 'answered'])
          .order('created_at', { ascending: false })
      : { data: [] };
    const fifteenMinAgo = Date.now() - 15 * 60_000;
    const persistedByRun = {};
    for (const p of persisted ?? []) {
      if (persistedByRun[p.run_id]) continue; // keep the newest row per run (order is created_at desc)
      if (p.status === 'answered' && (!p.answered_at || new Date(p.answered_at).getTime() < fifteenMinAgo)) continue;
      persistedByRun[p.run_id] = p;
    }
    const decisions = (runs ?? [])
      .map((r) => {
        const kind = classifyDecision(r, byRun[r.id] ?? []);
        if (!kind) return null;
        const gateDetail = kind === 'review_blocked' ? latestGateByRun[r.id]?.detail ?? null : null;
        const row = { ...r, kind, decision: decisionTextFor(kind, r), objections: gateDetail?.objections ?? undefined };
        const p = persistedByRun[r.id];
        if (p) {
          row.decisionId = p.id;
          row.decision = p.question;
          row.question = p.question;
          row.answerKind = p.kind;
          row.options = p.options ?? null;
          row.context = p.context ?? null;
          row.answered = p.status === 'answered';
          row.answer = p.answer ?? null;
          row.answeredBy = p.answered_by ?? null;
          row.answeredAt = p.answered_at ?? null;
        }
        return row;
      })
      .filter(Boolean);
    res.json({ decisions, count: decisions.length });
  });

  const sanitizeAnswerText = (v: unknown) => String(v ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 500);
  const ARCH_ANSWER_OPTIONS = new Set(['approve', 'request_changes', 'reject']);

  // Answer a persisted decision (issue #52) — the interactive counterpart of the Decisions panel's
  // question/options. Reuses the same resume/approve machinery a manual admin action already uses:
  // review_blocked/pr_closed_partial answers resume the run via resumeRunForDecision(); an
  // architecture answer approves/sends-back/rejects via approveArchitecture() or an inline CAS. A
  // decision resolved to config_blocked (kill_switch/authorization, or a security-review block) is
  // NOT agent-discussable — there is nothing an answer could fix short of Setup — so it is rejected.
  router.post('/decisions/:id/answer', async (req, res) => {
    if (!rateLimit(`se-admin:decision-answer:${clientIp(req)}`, 30, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const { data: decision } = await supabase.from('se_decisions').select('*').eq('id', id).maybeSingle();
    if (!decision) return res.status(404).json({ error: 'not found' });
    if (decision.status !== 'pending') {
      return res.status(409).json({ error: { code: 'already_answered', message: `decision is ${decision.status}` } });
    }
    const { data: run } = await supabase.from('se_runs')
      .select('id, site_id, project_id, status, kind, archived_at, current_phase, error, repo_owner, repo_name, issue_number')
      .eq('id', decision.run_id).maybeSingle();
    if (!run) return res.status(404).json({ error: 'run not found' });
    if (await denyIfNotApprover(req, res, run)) return;   // Advance action

    // ── Validate the answer shape against the decision's kind ──────────────────────────────
    let optionId: string | null = null;
    let text = '';
    if (decision.kind === 'choice') {
      optionId = typeof req.body?.option_id === 'string' ? req.body.option_id : null;
      const valid = (decision.options ?? []).some((o: any) => o?.id === optionId);
      if (!optionId || !valid) return res.status(400).json({ error: { code: 'invalid_option', message: 'option_id must match one of the decision options' } });
      text = sanitizeAnswerText(req.body?.text);
    } else {
      text = sanitizeAnswerText(req.body?.text);
      if (!text) return res.status(400).json({ error: { code: 'empty_answer', message: 'text is required' } });
    }

    // A true architecture decision if the run is still at (or past) the architecture gate — the run's
    // status, not decision.kind alone, disambiguates this from a coincidentally-shaped choice decision.
    const isArchitecture = ARCH_STATES.includes(run.status) && ARCH_ANSWER_OPTIONS.has(optionId ?? '');
    if (isArchitecture && (optionId === 'request_changes' || optionId === 'reject') && !text) {
      return res.status(400).json({ error: { code: 'empty_answer', message: 'text is required for this option' } });
    }

    // Non-architecture origin: re-derive the same classification the resume route uses, and reject
    // outright if it resolves to config_blocked — that class is not agent-discussable.
    let originKind: string | null = null;
    let gateDetail: any = null;
    if (!isArchitecture) {
      const { data: prs } = await supabase.from('se_run_prs').select('state').eq('run_id', run.id);
      originKind = classifyDecision(run, prs ?? []);
      if (originKind === 'config_blocked' || originKind == null) {
        return res.status(400).json({ error: { code: 'not_answerable', message: 'This block is a configuration/credential issue — resolve it in Setup, then resume the run.' } });
      }
      if (originKind === 'review_blocked') {
        const { data: gate } = await supabase.from('se_gates')
          .select('detail').eq('run_id', run.id).eq('gate', 'adversarial_review').order('created_at', { ascending: false }).limit(1).maybeSingle();
        gateDetail = gate?.detail ?? null;
      }
    }

    const actorId = authorOf(req);
    const answer = decision.kind === 'choice' ? { option_id: optionId, text: text || undefined } : { text };
    // A distilled review_blocked decision (workers/review.ts's distillDecision) can ALSO be
    // kind:'choice' with custom option ids/labels, not just the fixed architecture options. The
    // resumed agent needs to see WHICH option was picked, not just the optional free-text reason —
    // so build the human-readable summary from the option's label whenever one was selected.
    const chosenLabel = decision.kind === 'choice' ? (decision.options ?? []).find((o: any) => o.id === optionId)?.label ?? optionId : null;
    const answerSummary = chosenLabel ? (text ? `${chosenLabel} — ${text}` : chosenLabel) : text;

    // ── CAS the decision to answered BEFORE acting — a lost race means someone else already
    // answered it, so bail out rather than double-resume the run. ─────────────────────────────
    const { data: racedDecision, error: decisionError } = await supabase.from('se_decisions')
      .update({ status: 'answered', answer, answered_by: actorId, answered_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'pending')
      .select().single();
    if (decisionError) return res.status(500).json({ error: 'update failed' });
    if (!racedDecision) return res.status(409).json({ error: { code: 'already_answered', message: 'decision was already answered' } });

    let actionResult: any = { ok: true };
    let auditNote = `Answered decision: "${decision.question}" → `;
    if (isArchitecture) {
      if (optionId === 'approve') {
        if (run.status !== 'architecture_in_review') {
          actionResult = { status: 409, error: { code: 'not_finalized', message: 'Finalize (commit) the proposal before approving.' } };
        } else {
          actionResult = await approveArchitecture(supabase, null, run, { actorId, enqueueJob });
        }
        auditNote += 'approved.';
      } else if (optionId === 'request_changes') {
        actionResult = await resumeRunForDecision(supabase, null, run, 'architecture', {
          actorId, enqueueJob, note: `Architecture changes requested by admin: ${text}`,
        });
        auditNote += `requested changes — ${text}`;
      } else {
        const { data: raced } = await supabase.from('se_runs')
          .update({ status: 'blocked', error: `architecture proposal rejected: ${text}`, acting_user_id: actorId })
          .eq('id', run.id).eq('status', run.status)
          .select('id');
        actionResult = (!raced || raced.length === 0)
          ? { status: 409, error: { code: 'state_changed', message: 'Run state changed — refresh and retry if still needed.' } }
          : { ok: true };
        auditNote += `rejected — ${text}`;
      }
    } else if (originKind === 'review_blocked') {
      actionResult = await resumeRunForDecision(supabase, null, run, 'spec', {
        actorId, enqueueJob, extraJobData: { objections: gateDetail?.objections ?? [] },
        note: `Answered by admin: ${answerSummary}`,
      });
      auditNote += answerSummary;
    } else {
      // pr_closed_partial (the only remaining non-architecture, non-config_blocked DecisionKind).
      actionResult = await resumeRunForDecision(supabase, null, run, 'revise', {
        actorId, enqueueJob, note: `Answered by admin: ${answerSummary}`,
      });
      auditNote += answerSummary;
    }

    if (actionResult?.error) {
      // Roll the decision back to pending — the action didn't take effect, so the question is still open.
      await supabase.from('se_decisions').update({ status: 'pending', answer: null, answered_by: null, answered_at: null }).eq('id', id);
      return res.status(actionResult.status ?? 500).json({ error: actionResult.error });
    }

    if (run.issue_number) {
      try {
        const project = await getProject(supabase, run.project_id);
        if (project?.githubToken) await githubClient(project.githubToken).postComment(run.repo_owner, run.repo_name, run.issue_number, auditNote);
      } catch { /* best-effort */ }
    }

    const { data: freshRun } = await supabase.from('se_runs').select('*').eq('id', run.id).maybeSingle();
    res.json({ decision: racedDecision, run: freshRun });
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
    if (!rateLimit(`se-admin:pr-board:${clientIp(req)}`, 60, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    let project: string | null = null;
    if (req.query.project !== undefined && req.query.project !== '') {
      project = String(req.query.project);
      if (!UUID.test(project)) return res.status(400).json({ error: 'bad project' });
    }
    // Default scope: only PRs authored by the project's PAT user (author:@me) — far fewer GitHub
    // calls, and "who acts next" is really about your own PRs. ?all=1 widens to every open PR in
    // the connected repos. Cache the two scopes separately so they don't clobber each other.
    const showAll = req.query.all === '1';
    const cacheKey = `${project ?? 'all'}:${showAll ? 'all' : 'mine'}`;
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
      // Always bounded to the project's connected (enabled) code repos — that keeps a personal PAT's
      // unrelated org/personal PRs off the board. Within them, default to the PAT user's OWN PRs
      // (author:@me); ?all=1 widens to everyone's open PRs in those repos.
      const codeRepos = await getCodeRepos(supabase, p.id);
      const connected = new Set(codeRepos.map((r) => `${r.repoOwner}/${r.repoName}`.toLowerCase()));
      if (connected.size === 0) continue;
      const gh = githubClient(proj.githubToken);
      let items: Record<string, unknown>[] = [];
      try {
        const search = await gh.searchAuthoredOpenPRs(50, [...connected], !showAll);
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

    // "Needs submitting": runs whose code is complete but whose PR is human-gated (pr_submit_mode='manual').
    // They have no GitHub PR yet, so they are DB-driven (a cheap query, no GitHub calls) and shown as a
    // separate section on the board.
    let nsq = supabase.from('se_runs')
      .select('id, project_id, issue_number, title, repo_owner, repo_name, engineer_name, blast_radius, updated_at')
      .eq('status', 'ready_to_submit').is('archived_at', null)
      .order('updated_at', { ascending: false }).limit(50);
    if (project) nsq = nsq.eq('project_id', project);
    const { data: nsRows } = await nsq;
    const projName = new Map((projRows ?? []).map((p: Record<string, unknown>) => [p.id, p.name]));
    const needs_submitting = (nsRows ?? []).map((r: Record<string, unknown>) => ({
      run_id: r.id, project_id: r.project_id, project_name: projName.get(r.project_id) ?? null,
      issue_number: r.issue_number, title: r.title, repo: `${r.repo_owner}/${r.repo_name}`,
      engineer_name: r.engineer_name, blast_radius: r.blast_radius, updated_at: r.updated_at,
    }));

    const payload = { prs, counts, needs_submitting, project_errors: projectErrors, generated_at: new Date().toISOString() };
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

  // Connect an EXISTING external PR (opened outside Gatewaze) to a WATCHING run, so the pr-monitor
  // reconciler tracks it and auto-revises on trusted review feedback — without the platform ever
  // merging it. Query params (body already parsed upstream). Core logic (incl. every validation:
  // connected repo, kill switch, PR-open + refname-safe branch, active-run dedupe) is SHARED with
  // the webhook's `agent:adopt` PR-label intake — lib/connect-pr.ts. kind='external_pr' makes the
  // reconciler skip issue bookkeeping and never auto-merge (see workers/pr-monitor.ts).
  router.post('/prs/connect', async (req, res) => {
    if (!rateLimit(`se-admin:connect:${clientIp(req)}`, 30, 60_000)) {
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
    const result = await connectExternalPr(supabase, { enqueueJob, logger }, {
      project: proj, owner, name, number, labeller: authorOf(req),
    });
    if (result.ok) return res.status(result.existing ? 200 : 201).json({ runId: result.runId, ...(result.existing ? { existing: true } : {}) });
    const status = { no_token: 400, intake_disabled: 409, repo_not_connected: 403, pr_not_open: 409, no_branch: 409, bad_branch: 422, insert_failed: 500, connect_failed: 500 }[result.code] ?? 500;
    res.status(status).json({ error: result.message });
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
    const [run, phases, events, gates, artifacts, messages, prs] = await Promise.all([
      supabase.from('se_runs').select('*, project:se_projects(name, avatar_emoji)').eq('id', id).maybeSingle(),
      supabase.from('se_phases').select('*').eq('run_id', id).order('started_at', { nullsFirst: true }),
      supabase.from('se_events').select('*').eq('run_id', id).order('seq').limit(2000),
      supabase.from('se_gates').select('*').eq('run_id', id).order('created_at'),
      supabase.from('se_artifacts').select('*').eq('run_id', id).order('created_at'),
      supabase.from('se_messages').select('*').eq('run_id', id).order('id'),
      supabase.from('se_run_prs').select('repo_owner, repo_name, pr_number, pr_url, state, branch').eq('run_id', id).order('created_at'),
    ]);
    if (!run.data) return res.status(404).json({ error: 'not found' });
    res.json({
      run: run.data, phases: phases.data ?? [], events: events.data ?? [],
      gates: gates.data ?? [], artifacts: artifacts.data ?? [], messages: messages.data ?? [],
      prs: prs.data ?? [],
    });
  });

  router.post('/runs/:id/message', async (req, res) => {
    if (!rateLimit(`se-admin:run-message:${clientIp(req)}`, 30, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
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
    const { data: run } = await supabase.from('se_runs').select('id, site_id, status, error, retry_count').eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: 'not found' });
    // A run parked at a gate (spec, architecture) is not a live session — a message is feedback on the
    // parked artifact, handled asynchronously by the matching refine job rather than streamed to a live agent.
    const archState = ['awaiting_architecture', 'architecture_in_review'].includes(run.status);
    const specState = run.status === 'awaiting_spec';
    const codeState = run.status === 'ready_to_submit';
    // A `blocked` run is only agent-discussable when the block itself is something the agent can act
    // on (review_blocked, pr_closed_partial) — a config_blocked run (authorization/kill_switch) needs
    // a config fix, not a chat, so it still 409s and points the admin at Setup (issue #49 §6).
    let blockedDiscussable = false;
    if (run.status === 'blocked') {
      const { data: prs } = await supabase.from('se_run_prs').select('state').eq('run_id', id);
      blockedDiscussable = classifyDecision(run, prs ?? []) !== 'config_blocked';
    }
    if (!archState && !specState && !codeState && !blockedDiscussable && !['queued', 'running', 'changes_requested'].includes(run.status)) return res.status(409).json({ error: `run is ${run.status}` });
    // Persist the images as markdown appended to the stored message so the transcript renders them
    // inline — the same `![](url)` convention se_messages already carries for issue attachments.
    const stored = images.length
      ? `${content}${content && '\n\n'}` + images.map((u: string, i: number) => `![screenshot-${i + 1}](${u})`).join('\n')
      : content;
    await supabase.from('se_messages').insert({ run_id: id, site_id: run.site_id, role: 'admin', author: authorOf(req), content: stored });
    if (archState || specState || codeState) {
      // The stored message stays undelivered (delivered_at=null) = a mailbox. Enqueue the short refine job
      // (deterministic jobId dedups a rapid double-send); it drains ALL pending feedback and edits the
      // parked artifact — the spec, the architecture proposal, or (at the submission gate) the code.
      const worker = specState ? 'software-engineer:spec-refine' : codeState ? 'software-engineer:code-refine' : 'software-engineer:architecture-refine';
      const jobId = specState ? `se-spec-refine-${id}` : codeState ? `se-code-refine-${id}` : `se-arch-refine-${id}`;
      try { await enqueueJob?.('se', worker, { runId: id }, { jobId, removeOnComplete: true }); }
      catch (e) { logger?.warn?.('se: enqueue refine failed', { error: String(e) }); }
    } else if (blockedDiscussable) {
      // No live agent to stream to and no refine job to run — the message just sits in the mailbox
      // (delivered_at=null) and surfaces via drainPendingAdminMessages the next time the run is Resumed.
    } else {
      try { await publishInput(getRedis?.(), id, { kind: 'chat', content, images }); }
      catch (e) { logger?.warn?.('se: publish chat failed', { error: String(e) }); }
    }
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

  // Resume a FAILED run back into the phase that failed, keeping the same run id + full message/event
  // history (issue #36). Modeled on spec/approve below: jump straight to 'running' rather than 'queued'
  // — a resume is an admin continuing a run that already occupies its concurrency slot, so it bypasses
  // dispatchProject's promotion path on purpose (that path always re-enqueues 'intake', which would
  // restart the pipeline instead of retrying the phase that actually failed). Gated the same way as the
  // other Advance actions (spend tokens + PAT push power) via denyIfNotApprover.
  router.post('/runs/:id/resume', async (req, res) => {
    if (!rateLimit(`se-admin:resume:${clientIp(req)}`, 30, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const { data: run } = await supabase.from('se_runs')
      .select('id, site_id, project_id, status, kind, archived_at, current_phase, error').eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: 'not found' });
    // issue #49: `blocked` joined `failed` as a resumable status — a run parked on a closed-unmerged
    // PR or a skeptic block is just as resumable as a crashed phase, it just resolves a different
    // target phase below (per its DecisionKind) instead of the last-FAILED se_phases row.
    if (!['failed', 'blocked'].includes(run.status)) return res.status(409).json({ error: { code: 'not_resumable', message: `run is ${run.status}` } });
    if (run.archived_at) return res.status(409).json({ error: { code: 'archived', message: 'Unarchive the run before resuming it.' } });
    if (run.kind === 'interactive') return res.status(409).json({ error: { code: 'not_resumable', message: 'Interactive sessions cannot be resumed this way.' } });
    if (await denyIfNotApprover(req, res, run)) return;   // Advance action

    let resumePhase = null;
    let kind = null;
    let gateDetail = null;
    let lastFailed = null;
    let extraJobData = {};
    if (run.status === 'blocked') {
      // Disambiguate the block (issue #49 §1) so the run rejoins the pipeline at the RIGHT phase —
      // a closed-unmerged PR needs `revise`, a skeptic block needs a fresh `spec` draft, and a
      // config block (authorization/kill_switch) just retries whatever phase it was already on.
      const { data: prs } = await supabase.from('se_run_prs').select('state').eq('run_id', id);
      kind = classifyDecision(run, prs ?? []);
      if (kind === 'review_blocked') {
        const { data: gate } = await supabase.from('se_gates')
          .select('detail').eq('run_id', id).eq('gate', 'adversarial_review').order('created_at', { ascending: false }).limit(1).maybeSingle();
        gateDetail = gate?.detail ?? null;
        resumePhase = 'spec';
        extraJobData = { objections: gateDetail?.objections ?? [] };
      } else if (kind === 'pr_closed_partial') {
        resumePhase = 'revise';
      } else {
        resumePhase = run.current_phase ?? null;
      }
    } else {
      // Ground truth for what actually failed is the latest FAILED se_phases row, not run.current_phase
      // (they can disagree, e.g. a crash mid-write) — prefer the phase row and fail closed if neither
      // resolves, rather than guessing and re-cloning into the wrong phase.
      const { data } = await supabase.from('se_phases')
        .select('phase, attempt').eq('run_id', id).eq('status', 'failed').order('started_at', { ascending: false }).limit(1).maybeSingle();
      lastFailed = data;
      resumePhase = lastFailed?.phase ?? run.current_phase ?? null;
    }
    if (!resumePhase) return res.status(409).json({ error: { code: 'no_phase', message: 'Could not determine which phase to resume.' } });

    const result = await resumeRunForDecision(supabase, null, run, resumePhase, {
      extraJobData, actorId: authorOf(req), enqueueJob,
      note: (attempt) => `Resumed by admin (attempt ${attempt} of ${resumePhase}). ${blockSummaryFor(kind, run, gateDetail)}`,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ resumed: true, phase: result.phase, attempt: result.attempt });
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
    if (await denyIfNotApprover(req, res, run)) return;   // Advance action
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

  // §7.6: the architecture-review gate (commit-to-main flow). A run parked at `awaiting_architecture`
  // has a DRAFT proposal stored as an se_artifacts row (kind='architecture'). The human refines it by
  // chatting (→ architecture-refine), FINALIZES it (commit the folder to the arch repo's main, no PR),
  // and APPROVES it (resume to implement). These endpoints back that flow.
  const ARCH_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  const ARCH_STATES = ['awaiting_architecture', 'architecture_in_review'];
  const latestArchDraft = async (runId: string): Promise<string> => {
    const { data } = await supabase.from('se_artifacts').select('content').eq('run_id', runId).eq('kind', 'architecture').order('created_at', { ascending: false }).limit(1).maybeSingle();
    return String(data?.content ?? '');
  };

  router.get('/runs/:id/architecture', async (req, res) => {
    if (!rateLimit(`se-admin:arch-get:${clientIp(req)}`, 120, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    }
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const { data: run } = await supabase.from('se_runs')
      .select('id, project_id, issue_number, status, architecture_repo, architecture_folder, architecture_path, architecture_commit_url')
      .eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: 'not found' });
    if (!ARCH_STATES.includes(run.status)) return res.status(404).json({ error: 'run is not at the architecture gate' });
    // The draft proposal is the latest kind='architecture' artifact — render it whether or not it has
    // been committed yet. Once finalized, architecture_commit_url points at the file on the arch repo's main.
    const markdown = await latestArchDraft(run.id);
    res.json({
      repo: run.architecture_repo, folder: run.architecture_folder, path: run.architecture_path,
      status: run.status, committed: run.status === 'architecture_in_review',
      commitUrl: run.architecture_commit_url, issueNumber: run.issue_number,
      plan: markdown ? { path: run.architecture_path, markdown } : null,
    });
  });

  // Finalize: commit the current draft to the architecture repo's main (no PR), matching that repo's
  // convention, and move the run to `architecture_in_review` (external review pending + approve gate).
  router.post('/runs/:id/architecture/finalize', async (req, res) => {
    if (!rateLimit(`se-admin:arch-finalize:${clientIp(req)}`, 30, 60_000)) return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const { data: run } = await supabase.from('se_runs').select('id, site_id, project_id, status, architecture_repo, architecture_folder, architecture_path').eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: 'not found' });
    if (run.status !== 'awaiting_architecture' || !run.architecture_repo || !run.architecture_path || !ARCH_REPO_RE.test(run.architecture_repo)) {
      return res.status(409).json({ error: 'run is not a finalizable architecture draft' });
    }
    if (await denyIfNotApprover(req, res, run)) return;   // Advance action
    const content = await latestArchDraft(run.id);
    if (content.trim().length < 200) return res.status(409).json({ error: 'no draft proposal to finalize' });
    const project = await getProject(supabase, run.project_id);
    if (!project?.githubToken) return res.status(400).json({ error: 'project has no GitHub credential' });
    const [owner, name] = run.architecture_repo.split('/');
    let url: string | null = null;
    try {
      const result = await githubClient(project.githubToken).putFile(owner, name, run.architecture_path, content, `Add architecture proposal: ${run.architecture_folder ?? run.architecture_path}`);
      url = result?.content?.html_url ?? null;
    } catch (e) {
      logger?.warn?.('se: architecture finalize (commit) failed', { run: id, error: String((e as Error)?.message ?? e) });
      return res.status(502).json({ error: { code: 'commit_failed', message: 'Could not commit the proposal to the architecture repo.' } });
    }
    await supabase.from('se_runs').update({ status: 'architecture_in_review', architecture_commit_url: url }).eq('id', id).eq('status', 'awaiting_architecture');
    try { await supabase.from('se_messages').insert({ run_id: id, site_id: run.site_id, role: 'system', author: authorOf(req), content: `Proposal committed to ${run.architecture_repo}. Awaiting architectural review.` }); } catch { /* */ }
    // Refresh the pending decision's context with the real commit URL (it was null at awaiting_architecture
    // emission time, since nothing was committed yet) — supersede+reinsert keeps the same fixed option set.
    try {
      await createOrSupersedeDecision(supabase, {
        runId: id, projectId: run.project_id, siteId: run.site_id, phase: 'architecture',
        question: 'An architecture proposal is ready for review. What should happen next?',
        kind: 'choice', options: ARCHITECTURE_DECISION_OPTIONS,
        context: url,
      });
    } catch { /* best-effort */ }
    res.json({ committed: true, url, status: 'architecture_in_review' });
  });

  // Approve: the architectural review is done → resume the run to implementation. Only from the committed
  // `architecture_in_review` state (the proposal is on the arch repo's main for the record).
  router.post('/runs/:id/architecture/approve', async (req, res) => {
    if (!rateLimit(`se-admin:arch-approve:${clientIp(req)}`, 30, 60_000)) return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const { data: run } = await supabase.from('se_runs').select('id, site_id, status, repo_owner, repo_name, issue_number, project_id').eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: 'not found' });
    if (run.status !== 'architecture_in_review') return res.status(409).json({ error: 'run is not awaiting architecture approval' });
    if (await denyIfNotApprover(req, res, run)) return;   // Advance action
    const result = await approveArchitecture(supabase, null, run, { actorId: authorOf(req), enqueueJob });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ approved: true, resuming: true });
  });

  // Submit the pull request for a run whose code is complete but whose submission is human-gated
  // (pr_submit_mode='manual'). Re-enqueues the pr phase with submitApproved=true, which opens the PR(s).
  router.post('/runs/:id/submit-pr', async (req, res) => {
    if (!rateLimit(`se-admin:submit-pr:${clientIp(req)}`, 30, 60_000)) return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const { data: run } = await supabase.from('se_runs').select('id, site_id, project_id, status').eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: 'not found' });
    if (run.status !== 'ready_to_submit') return res.status(409).json({ error: 'run is not ready to submit' });
    if (await denyIfNotApprover(req, res, run)) return;   // Advance action
    const { error } = await supabase.from('se_runs').update({ status: 'running', current_phase: 'pr', acting_user_id: authorOf(req) }).eq('id', id).eq('status', 'ready_to_submit');
    if (error) return res.status(500).json({ error: 'update failed' });
    try { await enqueuePhase({ enqueueJob }, id, 'pr', { submitApproved: true }); } catch (e) { logger?.warn?.('se: enqueue pr (submit) failed', { error: String(e) }); }
    try { await supabase.from('se_messages').insert({ run_id: id, site_id: run.site_id, role: 'system', author: authorOf(req), content: 'Submitting the pull request.' }); } catch { /* */ }
    res.json({ submitting: true });
  });

  // §phase-gates: the SPEC gate. A run parked at `awaiting_spec` has a self-reviewed spec (se_artifacts
  // kind='spec'). A reviewer refines it by chatting (→ spec-refine, routed by the message route); an
  // approver approves it to advance to architecture or implement.
  const latestSpecArtifact = async (runId: string): Promise<string> => {
    const { data } = await supabase.from('se_artifacts').select('content').eq('run_id', runId).eq('kind', 'spec').order('created_at', { ascending: false }).limit(1).maybeSingle();
    return String(data?.content ?? '');
  };
  router.get('/runs/:id/spec', async (req, res) => {
    if (!rateLimit(`se-admin:spec-get:${clientIp(req)}`, 120, 60_000)) return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const { data: run } = await supabase.from('se_runs').select('id, project_id, status, refine_count').eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: 'not found' });
    if (run.status !== 'awaiting_spec') return res.status(404).json({ error: 'run is not at the spec gate' });
    const markdown = await latestSpecArtifact(run.id);
    const project = await getProject(supabase, run.project_id);
    res.json({ status: run.status, markdown, refineCount: run.refine_count ?? 0, budget: { used: run.refine_count ?? 0, max: project?.refineBudget ?? null } });
  });

  // Approve the spec (Advance): resume the run to architecture (if this project has an architecture gate)
  // or straight to implement.
  router.post('/runs/:id/spec/approve', async (req, res) => {
    if (!rateLimit(`se-admin:spec-approve:${clientIp(req)}`, 30, 60_000)) return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    const id = req.params.id;
    if (!UUID.test(id)) return res.status(400).json({ error: 'bad id' });
    const { data: run } = await supabase.from('se_runs').select('id, site_id, project_id, status, kind, current_phase').eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: 'not found' });
    if (run.status !== 'awaiting_spec') return res.status(409).json({ error: 'run is not awaiting spec approval' });
    if (await denyIfNotApprover(req, res, run)) return;   // Advance action
    const project = await getProject(supabase, run.project_id);
    const next = project?.architectureRepo && run.kind !== 'external_pr' ? 'architecture' : 'implement';
    const { error } = await supabase.from('se_runs').update({ status: 'running', current_phase: next, acting_user_id: authorOf(req) }).eq('id', id).eq('status', 'awaiting_spec');
    if (error) return res.status(500).json({ error: 'update failed' });
    try { await enqueuePhase({ enqueueJob }, id, next); } catch (e) { logger?.warn?.('se: enqueue after spec approve failed', { error: String(e) }); }
    try { await supabase.from('se_messages').insert({ run_id: id, site_id: run.site_id, role: 'system', author: authorOf(req), content: `Spec approved — proceeding to ${next}.` }); } catch { /* */ }
    res.json({ approved: true, next });
  });

  // ── Per-user credentials (§12.2) — self-service ─────────────────────────────
  // Each signed-in user manages THEIR OWN GitHub PAT + model credentials + GitHub identity, used by runs
  // they advance on a project in per_user/mixed credential mode. Scoped to the caller (authorOf(req)) as a
  // global default (project_id null); credentials are sealed and returned only as a masked last4. GitHub
  // login/email is the identity map, so a GitHub reporter can be matched to the user.
  const GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  const singleSiteId = async (): Promise<string | null> => {
    const { data: p } = await supabase.from('se_projects').select('site_id').limit(1).maybeSingle();
    if (p?.site_id) return p.site_id;
    const { data: s } = await supabase.from('sites').select('id').limit(1).maybeSingle();
    return s?.id ?? null;
  };

  router.get('/me/credentials', async (req, res) => {
    if (!rateLimit(`se-admin:me-cred:${clientIp(req)}`, 120, 60_000)) return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    const userId = authorOf(req);
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });
    const { data: cred } = await supabase.from('se_user_credentials')
      .select('github_pat_last4, model_cred_last4, codex_cred_last4').eq('user_id', userId).is('project_id', null).maybeSingle();
    const { data: idm } = await supabase.from('se_identity_map')
      .select('github_login, email').eq('user_id', userId).is('project_id', null).limit(1).maybeSingle();
    res.json({
      github_pat_last4: cred?.github_pat_last4 ?? null,
      model_cred_last4: cred?.model_cred_last4 ?? null,
      codex_cred_last4: cred?.codex_cred_last4 ?? null,
      github_login: idm?.github_login ?? null,
      email: idm?.email ?? null,
    });
  });

  router.put('/me/credentials', async (req, res) => {
    if (!rateLimit(`se-admin:me-cred-put:${clientIp(req)}`, 30, 60_000)) return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
    const userId = authorOf(req);
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });
    const b = req.body ?? {};
    const siteId = await singleSiteId();
    if (!siteId) return res.status(500).json({ error: 'no site configured' });

    // Credentials: seal any provided secret; an empty/absent value leaves that slot unchanged. project_id
    // is null (a per-user global default), and because a unique constraint treats null as distinct we
    // update-or-insert the existing global row by id rather than upserting.
    const credPatch: Record<string, unknown> = {};
    for (const [field, col] of [['github_pat', 'github_pat'], ['model_cred', 'model_cred'], ['codex_cred', 'codex_cred']] as const) {
      if (b[field]) { const s = sealToken(String(b[field])); credPatch[`${col}_ciphertext`] = s.ciphertext; credPatch[`${col}_last4`] = s.last4; }
    }
    if (Object.keys(credPatch).length) {
      credPatch.updated_at = new Date().toISOString();
      const { data: existing } = await supabase.from('se_user_credentials').select('id').eq('user_id', userId).is('project_id', null).maybeSingle();
      if (existing?.id) await supabase.from('se_user_credentials').update(credPatch).eq('id', existing.id);
      else await supabase.from('se_user_credentials').insert({ site_id: siteId, user_id: userId, project_id: null, ...credPatch });
    }

    // Identity map: the caller's GitHub login (+ optional email). Validated as a GitHub login. Replace any
    // existing global mapping for this user so it stays single-valued.
    if (b.github_login !== undefined) {
      const login = String(b.github_login ?? '').trim();
      if (login && !GH_LOGIN_RE.test(login)) return res.status(422).json({ error: { code: 'invalid_input', message: 'Not a valid GitHub login' } });
      const email = b.email == null ? null : String(b.email).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200) || null;
      await supabase.from('se_identity_map').delete().eq('user_id', userId).is('project_id', null);
      if (login) await supabase.from('se_identity_map').insert({ site_id: siteId, user_id: userId, project_id: null, github_login: login, email });
    }
    res.json({ ok: true });
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
      let delegated = null;
      const inst = process.env.SE_INSTANCE_ID || 'default';
      if (assign && proj.primaryInstanceId && proj.primaryInstanceId !== inst) {
        // Cross-instance intake (§2.2): THIS instance is intake-only for the project (e.g. prod files
        // feedback; staging runs the agents). The trigger label is on the issue — the OWNING instance
        // discovers it via its webhook or the intake-poll cron. Never create/dispatch a local run
        // here: with no runner on this instance the job would strand on an unconsumed queue.
        delegated = proj.primaryInstanceId;
      } else if (assign) {
        const { data: run } = await supabase.from('se_runs').insert({
          site_id: proj.siteId, project_id: projectId, instance_id: inst,
          repo_owner: proj.issuesRepoOwner, repo_name: proj.issuesRepoName, issue_number: created.number,
          title, labeller: authorOf(req), status: 'queued', current_phase: 'intake',
        }).select('id').single();
        runId = run?.id ?? null;
        await dispatchProject(supabase, { enqueueJob }, projectId);
      }
      res.status(201).json({ number: created.number, url: created.html_url, runId, delegated, attachmentsAttached: validUrls.length, attachmentsDropped });
    } catch (e) {
      logger?.warn?.('se: create issue failed', { error: String(e) });
      res.status(500).json({ error: 'create failed' });
    }
  });

  // Triage copilot (SPEC §10.5): one conversational turn — rough feedback in, either a clarifying
  // question or a structured DRAFT ticket out. Read-only: creating the issue is a separate,
  // human-confirmed call to POST /issues above. page_context (route/feature) comes from the
  // in-page widget entry point. Model calls are costly → own tighter rate bucket on top of the
  // router-wide limiter.
  router.post('/issues/triage', async (req, res) => {
    // Keyed by ADMIN (falling back to IP pre-auth-context) so one account can't starve others
    // behind a shared egress IP. NOTE: in-process bucket — adequate single-instance; move to Redis
    // + project token-budget accounting before horizontal scale (review follow-up).
    if (!rateLimit(`se-triage:${authorOf(req) ?? clientIp(req)}`, 10, 60_000)) {
      return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many triage requests' } });
    }
    const projectId = String(req.body?.project_id ?? '');
    if (!UUID.test(projectId)) return res.status(400).json({ error: 'project_id required' });
    const proj = await getProject(supabase, projectId);
    if (!proj) return res.status(404).json({ error: 'project not found' });
    if (!proj.modelCred) return res.status(400).json({ error: 'project has no model credential' });
    const pageContext = req.body?.page_context && typeof req.body.page_context === 'object'
      ? { route: typeof req.body.page_context.route === 'string' ? req.body.page_context.route : undefined,
          feature: typeof req.body.page_context.feature === 'string' ? req.body.page_context.feature : undefined }
      : null;
    try {
      // Structural fix: the model turn runs in a WORKER via the se-triage queue (job result awaited),
      // not in the API pod — prod's api memory limits OOMKilled the in-process CLI spawn.
      // SE_TRIAGE_INLINE=1 restores the in-process path (dev escape hatch without a consumer).
      const result = process.env.SE_TRIAGE_INLINE === '1'
        ? await Promise.race([
            runTriageTurn(proj, req.body?.messages, pageContext),
            new Promise((resolve) => setTimeout(() => resolve({ type: 'error', message: 'triage timed out' }), 90_000)),
          ])
        : await dispatchTriageTurn(
            { projectId, messages: req.body?.messages, pageContext },
          ).catch((e) => ({
            type: 'error',
            message: /timed out|Timeout/i.test(String(e?.message))
              ? 'triage timed out — is a triage consumer (se-runner) running?'
              : 'triage failed',
          }));
      res.json(result);
    } catch (e) {
      logger?.warn?.('se: triage failed', { error: redactToken(String(e?.message ?? e), proj.modelCred).slice(0, 300) });
      res.status(500).json({ error: 'triage failed' });
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
      'github_token_kind', 'github_app_installation_id', 'model_cred_kind', 'model', 'autonomy_mode', 'pr_submit_mode', 'credential_mode',
      'intake_enabled', 'max_concurrent_engineers', 'max_interactive_engineers', 'max_code_repos_per_run',
      'monthly_token_budget', 'per_run_token_ceiling', 'per_run_wallclock_minutes',
    ]) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    for (const k of ['name', 'description', 'avatar_emoji', 'commit_author_name', 'commit_author_email',
      'issues_repo_owner', 'issues_repo_name', 'trigger_label', 'primary_instance_id', 'memory_repo',
      'process_repo', 'process_path', 'process_ref', 'architecture_repo', 'architecture_ref', 'tracker_url_template']) {
      if (b[k] !== undefined) patch[k] = sanitize(b[k]);
    }
    if (b.name !== undefined && !patch.name) return res.status(400).json({ error: 'name cannot be empty' });
    if (Array.isArray(b.allowed_labellers)) patch.allowed_labellers = b.allowed_labellers.map(String);
    // §phase-gates: gate config (which human gates are on), the approver list, and the refine budget.
    if (b.gates && typeof b.gates === 'object' && !Array.isArray(b.gates)) {
      const g: Record<string, boolean> = {};
      for (const k of ['spec', 'architecture', 'submission']) if (typeof b.gates[k] === 'boolean') g[k] = b.gates[k];
      patch.gates = g;
    }
    if (Array.isArray(b.approvers)) patch.approvers = b.approvers.map(String).filter((s: string) => UUID.test(s));
    if (b.refine_budget !== undefined) patch.refine_budget = (b.refine_budget === null || b.refine_budget === '') ? null : Math.max(0, Number(b.refine_budget) || 0);
    // §7.5a: per-project skills. Validate + normalise through the SAME guard the runner uses
    // (parseSkillsConfig) so an unsafe repo/path/ref can never be persisted; an explicit non-array
    // clears it to []. This is an admin-only route, but the skills feed a Bash-capable session, so
    // the shape is enforced here too, not just trusted from the client.
    if (b.skills !== undefined) patch.skills = parseSkillsConfig(b.skills);
    if (b.github_token) {
      const s = sealToken(String(b.github_token));
      patch.github_token_ciphertext = s.ciphertext; patch.github_token_last4 = s.last4; patch.github_health = 'unknown';
      patch.github_user_login = null; patch.github_user_id = null; patch.github_user_name = null; // re-derive owner
    }
    if (b.model_cred) {
      const s = sealToken(String(b.model_cred));
      patch.model_cred_ciphertext = s.ciphertext; patch.model_cred_last4 = s.last4; patch.model_health = 'unknown';
    }
    // Credential model (§12): role-scoped credentials, sealed like the default PAT. Each is set-only and
    // returned only as a masked last4. An empty string is ignored (leaves the slot unchanged).
    for (const [field, col] of [
      ['committing_pat', 'committing_pat'], ['commenting_pat', 'commenting_pat'],
      ['pull_request_pat', 'pull_request_pat'], ['coding_agent_model', 'coding_agent_model'],
      ['slack_webhook', 'slack_webhook'],
    ] as const) {
      if (b[field]) {
        const s = sealToken(String(b[field]));
        patch[`${col}_ciphertext`] = s.ciphertext; patch[`${col}_last4`] = s.last4;
      }
    }
    // Billing control — validate server-side rather than trusting the client's min attr: finite,
    // non-negative, bounded (numeric(10,2) tops out well above any sane per-run spend). Null/'' clears.
    if (b.per_run_cost_ceiling_usd !== undefined) {
      if (b.per_run_cost_ceiling_usd === null || b.per_run_cost_ceiling_usd === '') {
        patch.per_run_cost_ceiling_usd = null;
      } else {
        const v = Number(b.per_run_cost_ceiling_usd);
        if (!Number.isFinite(v) || v < 0 || v > 100000) return res.status(400).json({ error: 'per_run_cost_ceiling_usd must be a number between 0 and 100000' });
        patch.per_run_cost_ceiling_usd = Math.round(v * 100) / 100;
      }
    }
    // Routing (migration 013). Validate server-side — these values reach --model flags and engine
    // dispatch, so only normalised ids/engines are persisted; junk entries are dropped, not stored.
    if (b.escalation_model !== undefined) {
      patch.escalation_model = b.escalation_model ? normalizeModel(b.escalation_model) : null;
      if (b.escalation_model && !patch.escalation_model) return res.status(400).json({ error: 'escalation_model is not a valid model id' });
    }
    if (b.phase_models !== undefined) {
      const KNOWN_PHASES = ['triage', 'spec', 'review', 'implement', 'verify', 'revise', 'reflect', 'review_kb', 'interactive'];
      let cfg = b.phase_models;
      try { if (typeof cfg === 'string') cfg = cfg.trim() ? JSON.parse(cfg) : {}; } catch { return res.status(400).json({ error: 'phase_models must be valid JSON' }); }
      const clean: any = {};
      if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
        for (const phase of KNOWN_PHASES) {
          const v = cfg[phase];
          if (!v || typeof v !== 'object') continue;
          const entry: any = {};
          if (v.engine === 'claude' || v.engine === 'codex') entry.engine = v.engine;
          if (v.model !== undefined && v.model !== '') {
            const m = normalizeModel(v.model);
            if (!m) return res.status(400).json({ error: `phase_models.${phase}.model is not a valid model id` });
            entry.model = m;
          }
          if (Object.keys(entry).length) clean[phase] = entry;
        }
      }
      patch.phase_models = clean;
    }
    if (b.openai_cred) {
      const s = sealToken(String(b.openai_cred));
      patch.openai_cred_ciphertext = s.ciphertext; patch.openai_cred_last4 = s.last4;
    }
    if (b.openai_cred === null || b.openai_cred === '') {
      patch.openai_cred_ciphertext = null; patch.openai_cred_last4 = null;
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
