// @ts-nocheck — express + supabase resolved at module-host install time.
/**
 * Admin API (JWT + is_admin gated by the platform for this prefix). Runs board + run detail, the
 * interactive control surface (chat into a live run, override, cancel), run archiving, and Setup:
 * PROJECTS — each project holds ALL credentials (git PAT + Claude model cred), its repos, shared
 * memory, policy, and a concurrency cap. Engineers are ephemeral (one per run, run.engineer_name).
 */
import express from 'express';
import { publishInput } from '../lib/input-channel.js';
import { sealToken, getProject } from '../lib/credentials.js';
import { githubClient } from '../lib/github.js';
import { dispatchProject } from '../lib/dispatch.js';
import { assertRemoteMcpServers } from '../lib/mcp.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROJECT_MASKED =
  'id, site_id, name, description, avatar_emoji,' +
  ' issues_repo_owner, issues_repo_name, trigger_label, primary_instance_id, max_code_repos_per_run,' +
  ' github_token_last4, github_token_kind, github_app_installation_id, github_health, github_checked_at,' +
  ' github_user_login, github_user_id, github_user_name,' +
  ' model_cred_last4, model_cred_kind, model, model_health, model_checked_at,' +
  ' commit_author_name, commit_author_email,' +
  ' allowed_labellers, intake_enabled, autonomy_mode, max_concurrent_engineers,' +
  ' has_mcp_config,' +
  ' monthly_token_budget, per_run_token_ceiling, per_run_wallclock_minutes, created_at, updated_at';

const sanitize = (v: unknown) =>
  v == null ? null : String(v).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200) || null;

// SECURITY TODO (prod hardening): these routes use the service-role client and are NOT yet route-level
// authN/authZ gated (the platform gates the /api/modules/* prefix by JWT; the UI attaches the session
// Bearer). Before prod: verify the operator JWT + enforce is_admin. Left open for local bring-up.
export function mountAdminRoutes(router, deps) {
  const { supabase, getRedis, logger, enqueueJob } = deps;
  router.use(express.json({ limit: '256kb' }));

  const authorOf = (req) => req.auth?.userId ?? req.user?.id ?? req.actor?.userId ?? null;
  // Freeing a slot (cancel/archive) should promote the next queued run for that project immediately,
  // rather than waiting for the pr-monitor cron safety-net.
  const dispatchFor = async (runId: string) => {
    try {
      const { data } = await supabase.from('se_runs').select('project_id').eq('id', runId).maybeSingle();
      if (data?.project_id) await dispatchProject(supabase, { enqueueJob }, data.project_id);
    } catch { /* best-effort */ }
  };

  // ── Runs ────────────────────────────────────────────────────────────────
  router.get('/runs', async (req, res) => {
    let q = supabase
      .from('se_runs')
      .select('*, project:se_projects(name, avatar_emoji)')
      .order('created_at', { ascending: false })
      .limit(200);
    if (String(req.query.archived) === '1') q = q.not('archived_at', 'is', null);
    else q = q.is('archived_at', null);
    if (req.query.status) q = q.eq('status', String(req.query.status));
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
    if (!content.trim()) return res.status(400).json({ error: 'empty' });
    const { data: run } = await supabase.from('se_runs').select('id, site_id, status').eq('id', id).maybeSingle();
    if (!run) return res.status(404).json({ error: 'not found' });
    if (!['queued', 'running', 'changes_requested'].includes(run.status)) return res.status(409).json({ error: `run is ${run.status}` });
    await supabase.from('se_messages').insert({ run_id: id, site_id: run.site_id, role: 'admin', author: authorOf(req), content });
    try { await publishInput(getRedis?.(), id, { kind: 'chat', content }); }
    catch (e) { logger?.warn?.('se: publish chat failed', { error: String(e) }); }
    res.status(202).json({ accepted: true });
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
    const body = req.body?.body != null ? String(req.body.body).slice(0, 60000) : '';
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
      res.status(201).json({ number: created.number, url: created.html_url, runId });
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
      'intake_enabled', 'max_concurrent_engineers', 'max_code_repos_per_run',
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
