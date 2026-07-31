// @ts-nocheck — express + supabase resolved at module-host install time.
/**
 * PUBLIC GitHub webhook receiver (§4, §12.5). HMAC-authenticated (X-Hub-Signature-256).
 *
 *  - issues.labeled with the project's trigger label on its ISSUES repo → route by instance
 *    (agent:build → primary; agent:build@<instance> → that instance), create a run, dispatch.
 *  - pull_request / pull_request_review → nudge the pr-monitor for the matching run (any of its PRs).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolveIssuesRepoProject, getProject } from '../lib/credentials.js';
import { dispatchProject } from '../lib/dispatch.js';
import { rateLimit, clientIp } from '../lib/rate-limit.js';

const INSTANCE = () => process.env.SE_INSTANCE_ID || 'default';

function header(headers, name) {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}
function verifyGitHub(secret, rawBody, signature) {
  if (!signature.startsWith('sha256=')) return false;
  const sig = signature.slice('sha256='.length);
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (sig.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex')); } catch { return false; }
}

export function mountWebhookRoute(router, deps) {
  const { supabase, enqueueJob, webhookSecret, logger } = deps;

  router.post('/webhook', async (req, res) => {
    // Rate-limit by IP before any work — this is the one unauthenticated (HMAC-only) surface.
    if (!rateLimit(`se-webhook:${clientIp(req)}`, 120, 60_000)) {
      return res.status(429).json({ accepted: false, reason: 'rate limited' });
    }
    const rawBody = Buffer.isBuffer(req.body) ? req.body : (req.rawBody ?? Buffer.from(''));
    const sig = header(req.headers, 'X-Hub-Signature-256');
    if (!webhookSecret || !verifyGitHub(webhookSecret, rawBody, sig)) {
      return res.status(401).json({ accepted: false, reason: 'bad signature' });
    }
    const event = header(req.headers, 'X-GitHub-Event');
    const delivery = header(req.headers, 'X-GitHub-Delivery');
    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return res.status(400).json({ accepted: false, reason: 'bad json' }); }

    const owner = payload.repository?.owner?.login;
    const name = payload.repository?.name;

    // ── PR lifecycle → nudge the monitor for the run owning this PR ──────────
    if (event === 'pull_request' || event === 'pull_request_review') {
      const prNum = payload.pull_request?.number;
      if (owner && name && prNum) {
        const { data: prRow } = await supabase.from('se_run_prs').select('run_id')
          .eq('repo_owner', owner).eq('repo_name', name).eq('pr_number', prNum).maybeSingle();
        if (prRow?.run_id) { await enqueueJob?.('jobs', 'software-engineer:pr-monitor', { runId: prRow.run_id }); return res.status(202).json({ accepted: true, runId: prRow.run_id, monitor: true }); }
      }
      return res.status(200).json({ accepted: false, reason: 'no matching run' });
    }

    // ── issue labelled on the ISSUES repo → maybe start a run ────────────────
    if (event !== 'issues' || payload.action !== 'labeled') {
      return res.status(200).json({ accepted: false, reason: 'ignored event' });
    }
    const repoProj = owner && name ? await resolveIssuesRepoProject(supabase, owner, name) : null;
    if (!repoProj) return res.status(200).json({ accepted: false, reason: 'not an issues repo' });
    const project = await getProject(supabase, repoProj.projectId);
    if (!project || !project.intakeEnabled) return res.status(200).json({ accepted: false, reason: 'intake disabled' });

    // Instance routing (§12.5). `<trigger>` → primary only; `<trigger>@<instance>` → that instance.
    const label = payload.label?.name ?? '';
    const trig = project.triggerLabel || 'agent:build';
    const inst = INSTANCE();
    let act = false;
    if (label === trig) act = !project.primaryInstanceId || project.primaryInstanceId === inst;
    else if (label === `${trig}@${inst}`) act = true;
    if (!act) return res.status(200).json({ accepted: false, reason: 'not this instance' });

    const labeller = payload.sender?.login ?? '';
    if (project.allowedLabellers.length && !project.allowedLabellers.includes(labeller)) {
      return res.status(200).json({ accepted: false, reason: 'labeller not allowed' });
    }

    const issue = payload.issue ?? {};
    // Idempotency: at most one live run per issue (also dedupes at-least-once deliveries).
    const { data: existing } = await supabase.from('se_runs').select('id')
      .eq('site_id', repoProj.siteId).eq('repo_owner', owner).eq('repo_name', name).eq('issue_number', issue.number)
      .in('status', ['queued', 'running', 'blocked', 'pr_open', 'watching', 'changes_requested']).maybeSingle();
    if (existing) return res.status(200).json({ accepted: false, reason: 'run already live', runId: existing.id });

    // Create QUEUED; the run's repo_owner/repo_name IS the issues repo (§2). Dispatcher promotes it.
    const { data: run, error } = await supabase.from('se_runs').insert({
      site_id: repoProj.siteId, project_id: repoProj.projectId, instance_id: inst,
      repo_owner: owner, repo_name: name, issue_number: issue.number, issue_node_id: issue.node_id ?? null,
      title: issue.title ?? null, labeller, status: 'queued', current_phase: 'intake',
    }).select('id').single();
    if (error || !run) { logger?.error?.('se: run insert failed', { error: String(error) }); return res.status(500).json({ accepted: false, reason: 'insert failed' }); }

    await dispatchProject(supabase, { enqueueJob }, repoProj.projectId);
    return res.status(202).json({ accepted: true, runId: run.id, delivery, instance: inst });
  });
}
