// @ts-nocheck — supabase client shape is resolved at module-host install time.
/**
 * Per-PROJECT credential resolution + sealing for the software-engineer module.
 *
 * A Project is the persistent config unit within a brand (tenant): it holds ALL credentials — the
 * GitHub PAT (git access + commit identity) AND the Claude model credential — plus its repos, shared
 * memory, policy, and a concurrency cap. Engineers are ephemeral (one per run), so no credential
 * lives at the engineer level. Secrets are AES-256-GCM encrypted via the platform helper; cleartext
 * is only held transiently inside a runner while a phase executes.
 */
import { encryptSecret, decryptSecret, getLast4 } from '@gatewaze/shared/modules';
import { githubClient } from './github.js';

export type ModelCredKind =
  | 'anthropic_api_key'
  | 'claude_code_oauth_token'
  | 'bedrock'
  | 'vertex';

export interface ProjectSettings {
  projectId: string;
  siteId: string;
  name: string;
  description: string | null;
  avatarEmoji: string | null;
  // GitHub (git access + commit identity — commits are authored as the PAT owner).
  githubToken: string | null;
  githubTokenKind: 'pat' | 'app';
  githubAppInstallationId: number | null;
  githubUserLogin: string | null;
  githubUserId: number | null;
  githubUserName: string | null;
  commitAuthorName: string | null;   // optional manual override of the derived token-owner identity
  commitAuthorEmail: string | null;
  // Claude model credential (used by every ephemeral engine on this project).
  modelCred: string | null;
  modelCredKind: ModelCredKind;
  model: string;
  // Routing (migration 013): partial per-phase {engine, model} map, escalation-ladder target,
  // and the OpenAI credential the codex engine runs on. See lib/model-select.ts.
  phaseModels: Record<string, { engine?: string; model?: string }>;
  escalationModel: string | null;
  openaiCred: string | null;
  openaiCredLast4: string | null;
  // Credential model (§12). Mode + role-scoped credentials. Each role PAT falls back to githubToken and
  // the coding-agent model falls back to modelCred, so an unconfigured project behaves exactly as before.
  credentialMode: 'shared' | 'per_user' | 'mixed';
  committingPat: string | null;    // authors commits (workspace clone/commit/push)
  commentingPat: string | null;    // posts comments on issues/PRs
  pullRequestPat: string | null;   // opens pull requests
  codingAgentModel: string | null; // the model credential the agent sessions run on
  slackWebhook: string | null;     // optional Slack incoming-webhook for gate-event notifications
  // Work source: the (private) issues repo, the trigger label, and multi-instance routing.
  issuesRepoOwner: string | null;
  issuesRepoName: string | null;
  triggerLabel: string;               // default 'agent:build'
  primaryInstanceId: string | null;   // instance that owns unqualified trigger label
  maxCodeReposPerRun: number;
  // §10: connected tools (MCP). Encrypted SDK-shaped config `{ servers: { name: {...} } }`; may
  // carry per-project bearer tokens, so it is sealed like any other credential. '' → no servers.
  mcpConfigCiphertext: string | null;
  // Dedicated memory git-sync repo (owner/name); the module pushes approved memory here. Null = off.
  memoryRepo: string | null;
  // §7.5a: per-project skills. Each entry names a git repo + plugin sub-path the runner clones and
  // loads as a LOCAL Claude plugin (skills/hooks) into every agent session. Admin-only. [] = none.
  skills: Array<{ repo: string; path: string; ref: string }>;
  // §7.6: development-process rules read at run start (roadmap repo file/dir) + an opt-in
  // architecture-review gate (proposals written to architectureRepo). All admin-only.
  processRepo: string | null;       // owner/name of the roadmap repo holding process rules
  processPath: string | null;       // file/dir within it (default 'PROCESS.md')
  processRef: string | null;        // branch/tag (default 'main')
  architectureRepo: string | null;  // owner/name of the arch proposals repo; null = gate off
  architectureRef: string | null;   // base branch for the proposal PR (default 'main')
  trackerUrlTemplate: string | null; // URL template with {key} for linking the external ticket in cross-repo PRs
  // Policy + concurrency.
  allowedLabellers: string[];
  intakeEnabled: boolean;
  autonomyMode: 'pr_only' | 'auto_merge_safe';
  prSubmitMode: 'auto' | 'manual';  // manual = stop at ready_to_submit for a human to open the PR
  specGate: boolean;                 // gates.spec: park at awaiting_spec after self-review for human review
  approvers: string[];               // gatewaze user ids allowed to Advance; empty = unrestricted (any admin)
  refineBudget: number | null;       // max chat-to-refine rounds per run; null = unlimited
  maxConcurrentEngineers: number;
  maxInteractiveEngineers: number;
  perRunTokenCeiling: number | null;
  /** USD ceiling per run, enforced at phase start against se_runs.cost_usd; null = off. */
  perRunCostCeilingUSD: number | null;
  perRunWallclockMinutes: number | null;
  monthlyTokenBudget: number | null;
}

export interface CodeRepo {
  repoOwner: string;
  repoName: string;
  writeMode: 'writable' | 'read_only';
  baseBranch: string | null;
  enabled: boolean;
  mergeEligible: boolean;
  contractOk: boolean;
  branchProtectionOk: boolean;
}

export interface IssuesRepoProject {
  projectId: string;
  siteId: string;
}

export function sealToken(plain: string): { ciphertext: string; last4: string } {
  return { ciphertext: encryptSecret(plain), last4: getLast4(plain) };
}
export function openToken(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  return decryptSecret(ciphertext);
}

/**
 * Resolve which PROJECT an issue belongs to, by its ISSUES repo. The (issues_repo) → project
 * mapping is the trigger path: work is defined in the project's private issues repo (§2). Enforces
 * isolation — the issues repo is the only entry for starting a run.
 */
export async function resolveIssuesRepoProject(sb: unknown, owner: string, name: string): Promise<IssuesRepoProject | null> {
  const { data, error } = await sb
    .from('se_projects')
    .select('id, site_id')
    .eq('issues_repo_owner', owner)
    .eq('issues_repo_name', name)
    .maybeSingle();
  if (error || !data) return null;
  return { projectId: data.id, siteId: data.site_id };
}

/**
 * Resolve which PROJECT a CODE repo is connected to (se_repos is unique on owner/name — a repo maps
 * to exactly one project per deployment). This is the webhook's `agent:adopt` PR-label entry: the
 * labelled PR lives in a code repo, not the issues repo, so `resolveIssuesRepoProject` cannot find
 * it. Disabled repo rows do not resolve.
 */
export async function resolveCodeRepoProject(sb: unknown, owner: string, name: string): Promise<IssuesRepoProject | null> {
  const { data, error } = await sb
    .from('se_repos')
    .select('project_id, site_id')
    .eq('repo_owner', owner)
    .eq('repo_name', name)
    .eq('enabled', true)
    .maybeSingle();
  if (error || !data?.project_id) return null;
  return { projectId: data.project_id, siteId: data.site_id };
}

/** The project's CODE repos (where the agent works) — writable ones are edit targets, read_only are
 *  context. Used by the multi-repo run engine (§7). */
export async function getCodeRepos(sb: unknown, projectId: string): Promise<CodeRepo[]> {
  const { data } = await sb
    .from('se_repos')
    .select('repo_owner, repo_name, write_mode, base_branch, enabled, merge_eligible, contract_ok, branch_protection_ok')
    .eq('project_id', projectId)
    .eq('enabled', true)
    .order('repo_owner');
  return (data ?? []).map((r) => ({
    repoOwner: r.repo_owner,
    repoName: r.repo_name,
    writeMode: r.write_mode ?? 'writable',
    baseBranch: r.base_branch ?? null,
    enabled: r.enabled,
    mergeEligible: r.merge_eligible,
    contractOk: r.contract_ok,
    branchProtectionOk: r.branch_protection_ok,
  }));
}

/** Load + decrypt a project's settings/credentials by project id. */
export async function getProject(sb: unknown, projectId: string): Promise<ProjectSettings | null> {
  if (!projectId) return null;
  const { data, error } = await sb.from('se_projects').select('*').eq('id', projectId).maybeSingle();
  if (error || !data) return null;
  return {
    projectId,
    siteId: data.site_id,
    name: data.name,
    description: data.description ?? null,
    avatarEmoji: data.avatar_emoji ?? null,
    githubToken: openToken(data.github_token_ciphertext),
    githubTokenKind: data.github_token_kind,
    githubAppInstallationId: data.github_app_installation_id,
    githubUserLogin: data.github_user_login ?? null,
    githubUserId: data.github_user_id ?? null,
    githubUserName: data.github_user_name ?? null,
    commitAuthorName: data.commit_author_name ?? null,
    commitAuthorEmail: data.commit_author_email ?? null,
    modelCred: openToken(data.model_cred_ciphertext),
    modelCredKind: data.model_cred_kind,
    model: data.model,
    phaseModels: data.phase_models && typeof data.phase_models === 'object' ? data.phase_models : {},
    escalationModel: data.escalation_model ?? null,
    openaiCred: openToken(data.openai_cred_ciphertext),
    openaiCredLast4: data.openai_cred_last4 ?? null,
    credentialMode: data.credential_mode === 'per_user' ? 'per_user' : data.credential_mode === 'mixed' ? 'mixed' : 'shared',
    committingPat: openToken(data.committing_pat_ciphertext) ?? openToken(data.github_token_ciphertext),
    commentingPat: openToken(data.commenting_pat_ciphertext) ?? openToken(data.github_token_ciphertext),
    pullRequestPat: openToken(data.pull_request_pat_ciphertext) ?? openToken(data.github_token_ciphertext),
    codingAgentModel: openToken(data.coding_agent_model_ciphertext) ?? openToken(data.model_cred_ciphertext),
    slackWebhook: openToken(data.slack_webhook_ciphertext),
    issuesRepoOwner: data.issues_repo_owner ?? null,
    issuesRepoName: data.issues_repo_name ?? null,
    triggerLabel: data.trigger_label ?? 'agent:build',
    primaryInstanceId: data.primary_instance_id ?? null,
    maxCodeReposPerRun: data.max_code_repos_per_run ?? 3,
    mcpConfigCiphertext: data.mcp_config_ciphertext ?? null,
    memoryRepo: data.memory_repo ?? null,
    skills: Array.isArray(data.skills) ? data.skills : [],
    processRepo: data.process_repo ?? null,
    processPath: data.process_path ?? null,
    processRef: data.process_ref ?? null,
    architectureRepo: data.architecture_repo ?? null,
    architectureRef: data.architecture_ref ?? null,
    trackerUrlTemplate: data.tracker_url_template ?? null,
    allowedLabellers: data.allowed_labellers ?? [],
    intakeEnabled: data.intake_enabled,
    autonomyMode: data.autonomy_mode,
    prSubmitMode: data.pr_submit_mode === 'manual' ? 'manual' : 'auto',
    specGate: !!(data.gates && typeof data.gates === 'object' && data.gates.spec === true),
    approvers: Array.isArray(data.approvers) ? data.approvers.map(String) : [],
    refineBudget: data.refine_budget ?? null,
    maxConcurrentEngineers: data.max_concurrent_engineers ?? 2,
    maxInteractiveEngineers: data.max_interactive_engineers ?? 1,
    perRunTokenCeiling: data.per_run_token_ceiling,
    perRunCostCeilingUSD: data.per_run_cost_ceiling_usd != null ? Number(data.per_run_cost_ceiling_usd) : null,
    perRunWallclockMinutes: data.per_run_wallclock_minutes,
    monthlyTokenBudget: data.monthly_token_budget,
  };
}

/**
 * Resolve the git commit identity for a project. Commits are authored as the TOKEN OWNER — so a PR
 * looks like the person whose PAT it is made it locally, not like an agent. Derived from GET /user
 * and cached on the project row on first use. A manual commit_author_* override wins when set.
 */
export async function resolveCommitIdentity(sb: unknown, project: ProjectSettings, token: string | null): Promise<{ name: string; email: string | null }> {
  let login = project.githubUserLogin;
  let id = project.githubUserId;
  let uname = project.githubUserName;

  if (token && (!login || !id)) {
    try {
      const u = await githubClient(token).getAuthenticatedUser();
      login = u?.login ?? login;
      id = u?.id ?? id;
      uname = u?.name ?? uname;
      if (login && id) {
        await sb.from('se_projects').update({
          github_user_login: login, github_user_id: id, github_user_name: uname,
          github_health: 'ok', github_checked_at: new Date().toISOString(),
        }).eq('id', project.projectId);
      }
    } catch { /* neutral fallback below */ }
  }

  const name = project.commitAuthorName?.trim() || uname || login || 'Software Engineer';
  const email = project.commitAuthorEmail?.trim() || (id && login ? `${id}+${login}@users.noreply.github.com` : null);
  return { name, email };
}

/**
 * Resolve which credentials a run acts as for each GitHub write role, honoring the project's credential
 * mode (§12). 'shared' (default) → the project's role-scoped PATs (each already falling back to the
 * default PAT), so behavior is unchanged. 'per_user'/'mixed' → when the run records an acting gatewaze
 * user who has stored their own credentials, that user's PAT drives the git identities so commits, the
 * pull request, and comments come from their real GitHub account. 'mixed' keeps the coding-agent model
 * shared; 'per_user' uses the user's model when they have one. Anything unconfigured falls back.
 */
export async function resolveRunCredentials(
  sb: unknown,
  project: ProjectSettings,
  run: { project_id?: string; acting_user_id?: string | null } | null,
): Promise<{ committingPat: string | null; commentingPat: string | null; pullRequestPat: string | null; modelCred: string | null }> {
  const base = {
    committingPat: project.committingPat, commentingPat: project.commentingPat,
    pullRequestPat: project.pullRequestPat, modelCred: project.modelCred,
  };
  const mode = project.credentialMode;
  if ((mode !== 'per_user' && mode !== 'mixed') || !run?.acting_user_id) return base;
  try {
    // Fetch the acting user's stored credential rows and pick the project-scoped one, else their global
    // default (project_id null). Filtered in JS to avoid interpolating into a PostgREST .or() filter.
    const { data: rows } = await (sb as { from: (t: string) => any }).from('se_user_credentials')
      .select('*').eq('user_id', run.acting_user_id);
    const list: any[] = Array.isArray(rows) ? rows : [];
    const row = list.find((r) => r.project_id === run.project_id) ?? list.find((r) => r.project_id == null);
    if (!row) return base;
    const pat = openToken(row.github_pat_ciphertext);
    const userModel = openToken(row.model_cred_ciphertext);
    return {
      committingPat: pat ?? base.committingPat,
      commentingPat: pat ?? base.commentingPat,
      pullRequestPat: pat ?? base.pullRequestPat,
      modelCred: mode === 'per_user' ? (userModel ?? base.modelCred) : base.modelCred,
    };
  } catch { return base; }
}
