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
  // Policy + concurrency.
  allowedLabellers: string[];
  intakeEnabled: boolean;
  autonomyMode: 'pr_only' | 'auto_merge_safe';
  maxConcurrentEngineers: number;
  maxInteractiveEngineers: number;
  perRunTokenCeiling: number | null;
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
    issuesRepoOwner: data.issues_repo_owner ?? null,
    issuesRepoName: data.issues_repo_name ?? null,
    triggerLabel: data.trigger_label ?? 'agent:build',
    primaryInstanceId: data.primary_instance_id ?? null,
    maxCodeReposPerRun: data.max_code_repos_per_run ?? 3,
    mcpConfigCiphertext: data.mcp_config_ciphertext ?? null,
    memoryRepo: data.memory_repo ?? null,
    skills: Array.isArray(data.skills) ? data.skills : [],
    allowedLabellers: data.allowed_labellers ?? [],
    intakeEnabled: data.intake_enabled,
    autonomyMode: data.autonomy_mode,
    maxConcurrentEngineers: data.max_concurrent_engineers ?? 2,
    maxInteractiveEngineers: data.max_interactive_engineers ?? 1,
    perRunTokenCeiling: data.per_run_token_ceiling,
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
