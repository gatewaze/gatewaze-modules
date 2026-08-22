// @ts-nocheck — express + supabase resolved at module-host install time.
/**
 * PUBLIC GitHub webhook receiver (§4, §12.5). HMAC-authenticated (X-Hub-Signature-256).
 *
 *  - issues.labeled with the project's trigger label on its ISSUES repo → route by instance
 *    (agent:build → primary; agent:build@<instance> → that instance), create a run, dispatch.
 *  - pull_request.labeled/opened with `agent:adopt` on a project-connected CODE repo, applied by a
 *    TRUSTED applier → connect the PR as a kind='external_pr' run (same core as POST /prs/connect),
 *    so a locally-developed PR can be handed to the pr-monitor without admin credentials.
 *  - pull_request / pull_request_review → nudge the pr-monitor for the matching run (any of its PRs).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolveIssuesRepoProject, resolveCodeRepoProject, getProject } from '../lib/credentials.js';
import { dispatchProject } from '../lib/dispatch.js';
import { rateLimit, clientIp } from '../lib/rate-limit.js';
import { githubClient } from '../lib/github.js';
import { parseDependencies, unmetDependencies, ensureWaitingMarker } from '../lib/dependencies.js';
import { connectExternalPr, ADOPT_LABEL } from '../lib/connect-pr.js';
import { isTrustedFeedbackAuthor } from '../lib/feedback-authz.js';

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

      // `agent:adopt` PR-label intake: hand an open PR on a CONNECTED code repo to the pr-monitor
      // as a kind='external_pr' run (shared core with POST /prs/connect — lib/connect-pr.ts).
      // Handled for the `labeled` action AND for `opened` when the label rode the PR's initial
      // label set. Instance routing mirrors the issues trigger: bare `agent:adopt` → primary
      // instance only; `agent:adopt@<instance>` → exactly that instance.
      // owner/name are only trusted after they exact-match a connected se_repos row below; the PR
      // number is validated here (it reaches a GitHub URL path) — parity with /prs/connect.
      if (event === 'pull_request' && owner && name && Number.isInteger(prNum) && prNum > 0 && (payload.action === 'labeled' || payload.action === 'opened')) {
        const inst = INSTANCE();
        const eventLabels = (payload.action === 'labeled'
          ? [payload.label?.name]
          : (payload.pull_request?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name))
        ).map((l) => String(l ?? '').trim());
        // Match both forms now; the bare label's primary-instance gate needs the project → below.
        const adoptLabels = eventLabels.filter((l) => l === ADOPT_LABEL || l === `${ADOPT_LABEL}@${inst}`);
        if (adoptLabels.length) {
          const repoProj = await resolveCodeRepoProject(supabase, owner, name);
          if (!repoProj) return res.status(200).json({ accepted: false, reason: 'not a connected code repo' });
          const project = await getProject(supabase, repoProj.projectId);
          if (!project || !project.intakeEnabled) return res.status(200).json({ accepted: false, reason: 'intake disabled' });
          // Same instance rule as the issues trigger: the bare label only acts on the primary
          // instance (or when no primary is configured); the @<instance> form already matched.
          const bare = adoptLabels.some((l) => String(l).trim() === ADOPT_LABEL);
          const qualified = adoptLabels.some((l) => String(l).trim() === `${ADOPT_LABEL}@${inst}`);
          const act = qualified || (bare && (!project.primaryInstanceId || project.primaryInstanceId === inst));
          if (!act) return res.status(200).json({ accepted: false, reason: 'not this instance' });
          // APPLIER TRUST (the security boundary — same fail-closed rule as intake's agent:spec:*/
          // agent:model:* labels, shared helper): the applier is the HMAC-verified event SENDER —
          // who GitHub says performed the labeling (or opened the PR carrying the label) — never a
          // repo/PR body field the payload author could shape. No run exists yet, so run=null:
          // ONLY the project's allowed_labellers are trusted; an empty list means nobody, because
          // label-write on a public code repo (triage) is far broader than the issues-repo floor
          // and an adopter becomes the run's trusted-feedback identity (revise-driving). Untrusted
          // → log + ignore. NEVER comment on the PR (no error-comment loop on re-labeling).
          const applier = payload.sender?.login ? String(payload.sender.login) : '';
          if (!isTrustedFeedbackAuthor(applier, project, null)) {
            logger?.info?.('se: agent:adopt ignored — applier not trusted', { repo: `${owner}/${name}`, pr: prNum, applier, delivery });
            return res.status(200).json({ accepted: false, reason: 'applier not trusted' });
          }
          const result = await connectExternalPr(supabase, { enqueueJob, logger }, {
            project, owner, name, number: prNum, labeller: applier,
          });
          if (!result.ok) {
            logger?.info?.('se: agent:adopt not connected', { repo: `${owner}/${name}`, pr: prNum, applier, code: result.code, delivery });
            return res.status(200).json({ accepted: false, reason: result.code });
          }
          if (result.existing) {
            // Label re-applied / PR already watched → dedupe to the live run; nudge its monitor.
            await enqueueJob?.('se', 'software-engineer:pr-monitor', { runId: result.runId });
            return res.status(200).json({ accepted: false, reason: 'run already live', runId: result.runId });
          }
          logger?.info?.('se: agent:adopt connected PR', { repo: `${owner}/${name}`, pr: prNum, applier, runId: result.runId, delivery });
          return res.status(202).json({ accepted: true, runId: result.runId, adopted: true, delivery, instance: inst });
        }
      }

      if (owner && name && prNum) {
        const { data: prRow } = await supabase.from('se_run_prs').select('run_id')
          .eq('repo_owner', owner).eq('repo_name', name).eq('pr_number', prNum).maybeSingle();
        if (prRow?.run_id) { await enqueueJob?.('se', 'software-engineer:pr-monitor', { runId: prRow.run_id }); return res.status(202).json({ accepted: true, runId: prRow.run_id, monitor: true }); }
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

    // Dependency sequencing: same deferral as the poll path — unmet deps mean no run yet; the
    // marker label + the poll's re-check take it from here (the webhook won't re-fire on its own).
    const wantDeps = parseDependencies(String(issue.body ?? ''), issue.number);
    if (wantDeps.length) {
      const gh = githubClient(project.githubToken);
      const unmet = await unmetDependencies(gh, owner, name, wantDeps);
      if (unmet.length) {
        const issueLabels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
        await ensureWaitingMarker(gh, owner, name, issue.number, issueLabels, unmet, wantDeps);
        return res.status(200).json({ accepted: false, reason: 'waiting on dependencies', unmet });
      }
    }

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
