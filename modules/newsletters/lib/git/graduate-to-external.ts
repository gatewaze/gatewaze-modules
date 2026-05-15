/**
 * graduateNewsletterToExternal — promote a newsletter collection's
 * internal git repo onto external GitHub/GitLab repo(s).
 *
 * Mirrors the sites module's graduate-to-external (sites/lib/git/
 * graduate-to-external.ts) but adapted for the newsletter channel
 * container (`newsletters_template_collections`). Two operating
 * modes are supported via the input shape:
 *
 *   1. LEGACY single-repo  — caller supplies `externalGitUrl`.
 *      Internal bare repo is mirror-pushed to that one external repo;
 *      `main` (theme/source) and `publish` (built output) both live
 *      there. This is the historical model, kept for back-compat with
 *      newsletters that have already graduated.
 *
 *   2. SEPARATE theme + publish repos — caller supplies BOTH
 *      `externalThemeGitUrl` and `externalPublishGitUrl`. The platform
 *      provisions a deploy key on EACH, mirror-pushes `main` to the
 *      theme repo and `publish` to the publish repo (default-branch
 *      mapping is configurable via `publish.external_branch`). This
 *      matches the sites graduated layout used by EXAMPLE: `example-theme`
 *      receives the Next.js source on its `main`, `example-publish`
 *      receives the built content on its `main`.
 *
 *  Either both separate-repo fields are present or only the single-repo
 *  field is — callers can't mix.
 *
 *  After success:
 *   - `newsletters_template_collections.git_provenance` is set to
 *     'external' and `git_url` holds the PRIMARY external URL (the
 *     publish repo in separate-repo mode, the single repo in legacy
 *     mode).
 *   - `git_url_theme` is set to the theme repo URL when separate-repo
 *     mode is used; null otherwise.
 *   - `config.publish.external_branch` defaults to 'main' for separate-
 *     repo mode (the publish repo's default branch) and is left at the
 *     legacy 'publish' default for single-repo mode unless the caller
 *     overrides it.
 *   - The user's PAT is dropped from memory; the platform persists only
 *     the Ed25519 deploy private keys via templates_sources rows for
 *     subsequent publishes.
 *   - The internal bare repo is soft-deleted (7-day grace).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface NewsletterRepoRef {
  /** UUID of the gatewaze_internal_repos row. */
  id: string;
  /** Filesystem path to the bare repo. */
  barePath: string;
}

export interface GraduateNewsletterArgs {
  collectionId: string;
  /** Display fields used for deploy key titles + log messages. */
  collection: { name: string; slug: string };
  /** The internal bare repo we're graduating from. */
  internalRepo: NewsletterRepoRef;
  /**
   * SINGLE-REPO MODE: one external URL that receives both branches.
   * Mutually exclusive with the separate-repo URLs below.
   */
  externalGitUrl?: string;
  /**
   * SEPARATE-REPO MODE: the theme source repo (receives `main`).
   * Both *_THEME and *_PUBLISH must be set together.
   */
  externalThemeGitUrl?: string;
  /** SEPARATE-REPO MODE: the publish/output repo (receives `publish`). */
  externalPublishGitUrl?: string;
  /**
   * One-time PAT supplied by the user. Used for deploy-key provisioning
   * and the initial mirror-push, then discarded. The same PAT must have
   * access to BOTH repos in separate-repo mode.
   */
  pat: string;
}

export interface GraduateNewsletterResult {
  /** Primary external URL (publish repo in separate mode; single repo otherwise). */
  externalGitUrl: string;
  /** Theme repo URL when separate-repo mode is used; null in single-repo mode. */
  externalThemeGitUrl: string | null;
  /** Provider key id for the PRIMARY (publish or single) repo. */
  deployKeyId: string | number;
  /** Provider key id for the theme repo; null in single-repo mode. */
  themeDeployKeyId: string | number | null;
  branchProtectionApplied: boolean;
  internalPurgeScheduledFor: string;
  /** 'publish' for single-repo mode, 'main' for separate-repo mode. */
  publishRemoteBranch: string;
  layout: 'single-repo' | 'separate-repos';
}

export interface GraduateNewsletterDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any };
  /** Optional override for tests; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /**
   * Soft-delete hook on the internal bare repo. Optional — when omitted
   * the bare repo is left in place (operator can purge later).
   */
  softDeleteInternalRepo?: (repo: NewsletterRepoRef) => Promise<void>;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

// ---------------------------------------------------------------------------
// Provider abstraction (identical contract to sites' graduate-to-external)
// ---------------------------------------------------------------------------

export type GitProvider = 'github' | 'gitlab';

interface ProviderOps {
  validatePatScope(pat: string, ownerRepo: string): Promise<string | null>;
  createDeployKey(args: {
    pat: string;
    ownerRepo: string;
    title: string;
    publicKey: string;
  }): Promise<string | number>;
  protectBranches(args: {
    pat: string;
    ownerRepo: string;
    branches: string[];
  }): Promise<boolean>;
}

export function detectProvider(url: string): GitProvider | null {
  if (/^https?:\/\/github\.com\//.test(url)) return 'github';
  if (/^https?:\/\/gitlab\.com\//.test(url)) return 'gitlab';
  if (/^git@github\.com:/.test(url)) return 'github';
  if (/^git@gitlab\.com:/.test(url)) return 'gitlab';
  return null;
}

export function parseOwnerRepo(url: string, provider: GitProvider): string | null {
  const cleaned = url
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/^git@[^:]+:/, '')
    .replace(/\.git$/, '');
  if (provider === 'github' && /^[\w-]+\/[\w.-]+$/.test(cleaned)) return cleaned;
  if (provider === 'gitlab' && /^[\w-]+(\/[\w.-]+)+$/.test(cleaned)) return cleaned;
  return null;
}

export function toSshUrl(httpsUrl: string, provider: GitProvider): string {
  const ownerRepo = parseOwnerRepo(httpsUrl, provider);
  if (!ownerRepo) return httpsUrl;
  if (provider === 'github') return `git@github.com:${ownerRepo}.git`;
  return `git@gitlab.com:${ownerRepo}.git`;
}

function providerOps(provider: GitProvider, fetchFn: typeof globalThis.fetch): ProviderOps {
  if (provider === 'github') return githubOps(fetchFn);
  return gitlabOps(fetchFn);
}

function githubOps(fetchFn: typeof globalThis.fetch): ProviderOps {
  return {
    async validatePatScope(pat, _ownerRepo) {
      const resp = await fetchFn('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' },
      });
      if (!resp.ok) return `GitHub auth failed: ${resp.status}`;
      const scopes = (resp.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim());
      if (!scopes.includes('repo') && !scopes.includes('public_repo')) {
        return 'PAT missing repo scope (or fine-grained Administration: read/write)';
      }
      return null;
    },
    async createDeployKey({ pat, ownerRepo, title, publicKey }) {
      const resp = await fetchFn(`https://api.github.com/repos/${ownerRepo}/keys`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title, key: publicKey, read_only: false }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`createDeployKey failed: ${resp.status} ${body}`);
      }
      const data = (await resp.json()) as { id: number };
      return data.id;
    },
    async protectBranches({ pat, ownerRepo, branches }) {
      let allOk = true;
      for (const branch of branches) {
        const resp = await fetchFn(
          `https://api.github.com/repos/${ownerRepo}/branches/${branch}/protection`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${pat}`,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              required_status_checks: null,
              enforce_admins: false,
              required_pull_request_reviews: null,
              restrictions: null,
              allow_force_pushes: false,
              allow_deletions: false,
            }),
          },
        );
        if (!resp.ok) {
          allOk = false;
          break;
        }
      }
      return allOk;
    },
  };
}

function gitlabOps(fetchFn: typeof globalThis.fetch): ProviderOps {
  return {
    async validatePatScope(pat, _ownerRepo) {
      const resp = await fetchFn('https://gitlab.com/api/v4/personal_access_tokens/self', {
        headers: { 'PRIVATE-TOKEN': pat },
      });
      if (!resp.ok) return `GitLab auth failed: ${resp.status}`;
      const data = (await resp.json()) as { scopes?: string[] };
      if (!data.scopes?.includes('api')) return 'PAT missing api scope';
      return null;
    },
    async createDeployKey({ pat, ownerRepo, title, publicKey }) {
      const projectPath = encodeURIComponent(ownerRepo);
      const resp = await fetchFn(`https://gitlab.com/api/v4/projects/${projectPath}/deploy_keys`, {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': pat, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, key: publicKey, can_push: true }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`createDeployKey failed: ${resp.status} ${body}`);
      }
      const data = (await resp.json()) as { id: number };
      return data.id;
    },
    async protectBranches({ pat, ownerRepo, branches }) {
      const projectPath = encodeURIComponent(ownerRepo);
      let allOk = true;
      for (const branch of branches) {
        const resp = await fetchFn(
          `https://gitlab.com/api/v4/projects/${projectPath}/protected_branches`,
          {
            method: 'POST',
            headers: { 'PRIVATE-TOKEN': pat, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: branch, push_access_level: 30, merge_access_level: 30 }),
          },
        );
        if (!resp.ok && resp.status !== 409) {
          allOk = false;
        }
      }
      return allOk;
    },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ResolvedLayout {
  layout: 'single-repo' | 'separate-repos';
  themeUrl: string | null;
  publishUrl: string;
  /** Branch on the PUBLISH remote that should receive the local `publish` ref. */
  publishRemoteBranch: 'publish' | 'main';
}

function resolveLayout(args: GraduateNewsletterArgs): ResolvedLayout {
  const hasSingle = !!args.externalGitUrl;
  const hasTheme = !!args.externalThemeGitUrl;
  const hasPublish = !!args.externalPublishGitUrl;

  if (hasSingle && (hasTheme || hasPublish)) {
    throw new Error(
      'graduate_layout_invalid: cannot mix externalGitUrl with externalThemeGitUrl / externalPublishGitUrl — choose single-repo OR separate-repos',
    );
  }
  if (!hasSingle && (!hasTheme || !hasPublish)) {
    throw new Error(
      'graduate_layout_invalid: separate-repos mode requires BOTH externalThemeGitUrl and externalPublishGitUrl',
    );
  }
  if (hasSingle) {
    return {
      layout: 'single-repo',
      themeUrl: null,
      publishUrl: args.externalGitUrl!,
      publishRemoteBranch: 'publish',
    };
  }
  return {
    layout: 'separate-repos',
    themeUrl: args.externalThemeGitUrl!,
    publishUrl: args.externalPublishGitUrl!,
    publishRemoteBranch: 'main',
  };
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function graduateNewsletterToExternal(
  args: GraduateNewsletterArgs,
  deps: GraduateNewsletterDeps,
): Promise<GraduateNewsletterResult> {
  const resolved = resolveLayout(args);

  // Validate provider + parse owner/repo for every URL we're going to
  // touch. Fail fast before we start mutating provider state.
  const publishProvider = detectProvider(resolved.publishUrl);
  if (!publishProvider) {
    throw new Error(`unsupported git provider: ${resolved.publishUrl}`);
  }
  const publishOwnerRepo = parseOwnerRepo(resolved.publishUrl, publishProvider);
  if (!publishOwnerRepo) {
    throw new Error(`could not parse owner/repo from URL: ${resolved.publishUrl}`);
  }

  let themeProvider: GitProvider | null = null;
  let themeOwnerRepo: string | null = null;
  if (resolved.themeUrl) {
    themeProvider = detectProvider(resolved.themeUrl);
    if (!themeProvider) {
      throw new Error(`unsupported git provider: ${resolved.themeUrl}`);
    }
    themeOwnerRepo = parseOwnerRepo(resolved.themeUrl, themeProvider);
    if (!themeOwnerRepo) {
      throw new Error(`could not parse owner/repo from URL: ${resolved.themeUrl}`);
    }
  }

  const fetchFn = deps.fetch ?? globalThis.fetch;
  const publishOps = providerOps(publishProvider, fetchFn);

  // 1. PAT scope check on the publish repo. (Same PAT covers both repos
  //    in separate-repos mode; GitHub's scope is account-wide for
  //    classic PATs and per-repo for fine-grained PATs, so this is a
  //    sufficient signal for both.)
  const scopeError = await publishOps.validatePatScope(args.pat, publishOwnerRepo);
  if (scopeError) {
    throw new Error(`pat_under_scoped: ${scopeError}`);
  }

  // 2. Generate Ed25519 deploy keypair(s). Separate keys per repo so the
  //    operator can rotate independently.
  const today = new Date().toISOString().slice(0, 10);
  const publishKey = await generateEd25519Keypair();
  const publishKeyTitle = resolved.layout === 'single-repo'
    ? `gatewaze-${args.collection.slug}-${today}`
    : `gatewaze-${args.collection.slug}-publish-${today}`;
  const publishDeployKeyId = await publishOps.createDeployKey({
    pat: args.pat,
    ownerRepo: publishOwnerRepo,
    title: publishKeyTitle,
    publicKey: publishKey.publicKey,
  });

  let themeKey: { publicKey: string; privateKey: string } | null = null;
  let themeDeployKeyId: string | number | null = null;
  if (resolved.themeUrl && themeProvider && themeOwnerRepo) {
    const themeOps = providerOps(themeProvider, fetchFn);
    themeKey = await generateEd25519Keypair();
    themeDeployKeyId = await themeOps.createDeployKey({
      pat: args.pat,
      ownerRepo: themeOwnerRepo,
      title: `gatewaze-${args.collection.slug}-theme-${today}`,
      publicKey: themeKey.publicKey,
    });
  }

  // 3. Branch protection (best-effort; warn on failure).
  const branchProtectionApplied = await publishOps.protectBranches({
    pat: args.pat,
    ownerRepo: publishOwnerRepo,
    branches: resolved.layout === 'single-repo' ? ['main', 'publish'] : ['main'],
  }).catch((err) => {
    deps.logger.warn('publish branch protection failed (continuing)', { error: err.message });
    return false;
  });
  if (resolved.themeUrl && themeProvider && themeOwnerRepo) {
    const themeOps = providerOps(themeProvider, fetchFn);
    await themeOps.protectBranches({
      pat: args.pat,
      ownerRepo: themeOwnerRepo,
      branches: ['main'],
    }).catch((err) => {
      deps.logger.warn('theme branch protection failed (continuing)', { error: err.message });
      return false;
    });
  }

  // 4. Push branches from internal bare repo to external remote(s) via SSH.
  const workTree = await mkdtemp(join(tmpdir(), 'gatewaze-newsletter-graduate-'));
  try {
    // Mirror-clone the internal bare repo locally so we don't mutate
    // its refs while pushing.
    const clone = await execGit(['clone', '--mirror', args.internalRepo.barePath, workTree]);
    if (clone.exitCode !== 0) {
      throw new Error(`internal clone failed: ${clone.stderr}`);
    }

    if (resolved.layout === 'single-repo') {
      // Push both refs to the same remote with --mirror.
      const sshKeyPath = join(workTree, 'publish_deploy_key');
      await writeFile(sshKeyPath, publishKey.privateKey, { mode: 0o600 });
      const sshCmd = sshCommandFor(sshKeyPath);
      const sshUrl = toSshUrl(resolved.publishUrl, publishProvider);
      await execGit(['remote', 'add', 'external', sshUrl], { cwd: workTree });
      const push = await execGit(['push', '--mirror', 'external'], {
        cwd: workTree,
        env: { GIT_SSH_COMMAND: sshCmd },
      });
      if (push.exitCode !== 0) {
        throw new Error(`push to external failed: ${push.stderr}`);
      }
    } else {
      // SEPARATE: theme repo gets `main` only; publish repo gets the
      // `publish` ref pushed onto its `main` branch (the default-branch
      // convention used by example-publish etc.).
      if (!themeKey || !themeProvider || !themeOwnerRepo) {
        // resolveLayout already guarantees themeUrl, but keep the
        // narrowing explicit for the type checker.
        throw new Error('graduate_layout_invalid: separate-repos mode missing theme key');
      }

      const themeKeyPath = join(workTree, 'theme_deploy_key');
      const publishKeyPath = join(workTree, 'publish_deploy_key');
      await writeFile(themeKeyPath, themeKey.privateKey, { mode: 0o600 });
      await writeFile(publishKeyPath, publishKey.privateKey, { mode: 0o600 });
      const themeSshUrl = toSshUrl(resolved.themeUrl!, themeProvider);
      const publishSshUrl = toSshUrl(resolved.publishUrl, publishProvider);

      // Theme: push `main` only. The internal bare repo may not have a
      // local `main` ref if the boilerplate cloned its theme as
      // `theme` — fall back to that branch when needed.
      const localThemeBranch = await pickLocalSourceBranch(workTree);
      await execGit(['remote', 'add', 'external-theme', themeSshUrl], { cwd: workTree });
      const themePush = await execGit(
        ['push', 'external-theme', `${localThemeBranch}:main`],
        { cwd: workTree, env: { GIT_SSH_COMMAND: sshCommandFor(themeKeyPath) } },
      );
      if (themePush.exitCode !== 0) {
        throw new Error(`push theme to external failed: ${themePush.stderr}`);
      }

      // Publish: push `publish` → `main` on the publish repo. If the
      // internal repo has no `publish` ref yet (no editions published),
      // skip the push — the publish-worker will push the first time
      // an edition lands.
      await execGit(['remote', 'add', 'external-publish', publishSshUrl], { cwd: workTree });
      const hasPublish = await execGit(['show-ref', '--verify', '--quiet', 'refs/heads/publish'], { cwd: workTree });
      if (hasPublish.exitCode === 0) {
        const publishPush = await execGit(
          ['push', 'external-publish', 'publish:main'],
          { cwd: workTree, env: { GIT_SSH_COMMAND: sshCommandFor(publishKeyPath) } },
        );
        if (publishPush.exitCode !== 0) {
          throw new Error(`push publish to external failed: ${publishPush.stderr}`);
        }
      } else {
        deps.logger.info('no local publish branch yet — skipping publish-repo initial push', {
          collectionId: args.collectionId,
        });
      }
    }
  } finally {
    await rm(workTree, { recursive: true, force: true });
  }

  // 5. Persist deploy key(s) into templates_sources so subsequent publishes
  //    can read them. The graduate flow REPLACES any prior PAT-bearing
  //    templates_sources row for this newsletter — we never persist the PAT.
  //
  //    The schema has no UNIQUE constraint on (library_id, kind, url),
  //    so we do an explicit select-then-update-or-insert to stay
  //    idempotent across re-graduations.
  await upsertTemplatesSource(deps.supabase, {
    library_id: args.collectionId,
    kind: 'git',
    label: resolved.layout === 'single-repo' ? 'External (single repo)' : 'External (publish repo)',
    url: resolved.publishUrl,
    branch: resolved.publishRemoteBranch,
    token_secret_ref: publishKey.privateKey,
    manifest_path: 'gatewaze-template.json',
  });
  if (resolved.themeUrl && themeKey) {
    await upsertTemplatesSource(deps.supabase, {
      library_id: args.collectionId,
      kind: 'git',
      label: 'External (theme repo)',
      url: resolved.themeUrl,
      branch: 'main',
      token_secret_ref: themeKey.privateKey,
      manifest_path: 'gatewaze-template.json',
    });
  }

  // 6. Update the collection row. We persist:
  //   - git_provenance='external' + git_url=<publish url>
  //   - git_url_theme=<theme url> when in separate-repos mode
  //   - config.publish.external_branch=<publishRemoteBranch> when it
  //     differs from the legacy default ('publish'). Setting it explicitly
  //     means the publish-worker doesn't have to infer.
  //   - config.theme.url=<theme url>, theme.ref='main' when in
  //     separate-repos mode (so the publish-worker theme overlay clones
  //     it on the next publish).
  interface CollectionConfigUpdate {
    git_provenance: 'external';
    git_url: string;
    git_url_theme: string | null;
    config: Record<string, unknown>;
  }

  // Read existing config so we don't clobber other keys the operator set
  // out-of-band. PostgREST doesn't have a `jsonb_set` builder, so a
  // read-modify-write inside the API is the simplest correct path.
  const existingRes = await deps.supabase
    .from('newsletters_template_collections')
    .select('config')
    .eq('id', args.collectionId)
    .maybeSingle();
  const existing = (existingRes as { data: { config: Record<string, unknown> | null } | null }).data;
  const baseConfig: Record<string, unknown> = (existing?.config && typeof existing.config === 'object')
    ? { ...existing.config }
    : {};
  const basePublish = (baseConfig.publish && typeof baseConfig.publish === 'object')
    ? { ...(baseConfig.publish as Record<string, unknown>) }
    : {};
  const baseTheme = (baseConfig.theme && typeof baseConfig.theme === 'object')
    ? { ...(baseConfig.theme as Record<string, unknown>) }
    : {};

  basePublish.external_branch = resolved.publishRemoteBranch;
  baseConfig.publish = basePublish;

  if (resolved.layout === 'separate-repos' && resolved.themeUrl) {
    baseTheme.url = resolved.themeUrl;
    // Default to 'main' if the operator hasn't pinned a more specific
    // ref. They can flip to a tag/SHA via the admin UI later.
    if (typeof baseTheme.ref !== 'string' || baseTheme.ref.length === 0) {
      baseTheme.ref = 'main';
    }
    baseConfig.theme = baseTheme;
  }

  const updatePayload: CollectionConfigUpdate = {
    git_provenance: 'external',
    git_url: resolved.publishUrl,
    git_url_theme: resolved.themeUrl,
    config: baseConfig,
  };

  await deps.supabase
    .from('newsletters_template_collections')
    .update(updatePayload)
    .eq('id', args.collectionId);

  // 7. Schedule internal repo soft-delete (7-day grace).
  const purgeAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  if (deps.softDeleteInternalRepo) {
    try {
      await deps.softDeleteInternalRepo(args.internalRepo);
    } catch (err) {
      deps.logger.warn('soft-delete of internal newsletter repo failed (non-fatal)', {
        collectionId: args.collectionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.logger.info('newsletter graduated to external git', {
    collectionId: args.collectionId,
    layout: resolved.layout,
    externalGitUrl: resolved.publishUrl,
    externalThemeGitUrl: resolved.themeUrl,
    deployKeyId: publishDeployKeyId,
    themeDeployKeyId,
    branchProtectionApplied,
    publishRemoteBranch: resolved.publishRemoteBranch,
  });

  return {
    externalGitUrl: resolved.publishUrl,
    externalThemeGitUrl: resolved.themeUrl,
    deployKeyId: publishDeployKeyId,
    themeDeployKeyId,
    branchProtectionApplied,
    internalPurgeScheduledFor: purgeAt,
    publishRemoteBranch: resolved.publishRemoteBranch,
    layout: resolved.layout,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface GitExecResult { exitCode: number; stdout: string; stderr: string }

function sshCommandFor(keyPath: string): string {
  return `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes`;
}

async function pickLocalSourceBranch(workTree: string): Promise<string> {
  // Boilerplate clones might use `theme` as the source-of-truth branch
  // (NEWSLETTERS_BOILERPLATE_BRANCH default in publish-to-git.ts is
  // 'theme'). Prefer `main` when present, then `theme`, then `master`.
  for (const candidate of ['main', 'theme', 'master']) {
    const res = await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`], { cwd: workTree });
    if (res.exitCode === 0) return candidate;
  }
  throw new Error('no_source_branch: internal repo has no main/theme/master ref to push as theme');
}

function execGit(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<GitExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

/**
 * Idempotent upsert into templates_sources keyed by (library_id, kind, url).
 * The schema has no unique constraint on those columns (it's a free-form
 * library-style table) so we manually look up then update or insert. This
 * makes re-graduating an already-graduated newsletter safe.
 */
async function upsertTemplatesSource(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any },
  row: {
    library_id: string;
    kind: 'git';
    label: string;
    url: string;
    branch: string;
    token_secret_ref: string;
    manifest_path: string;
  },
): Promise<void> {
  const existingRes = await supabase
    .from('templates_sources')
    .select('id')
    .eq('library_id', row.library_id)
    .eq('kind', row.kind)
    .eq('url', row.url)
    .maybeSingle();
  const existing = (existingRes as { data: { id: string } | null }).data;
  if (existing) {
    await supabase
      .from('templates_sources')
      .update({
        label: row.label,
        branch: row.branch,
        token_secret_ref: row.token_secret_ref,
        manifest_path: row.manifest_path,
      })
      .eq('id', existing.id);
  } else {
    await supabase.from('templates_sources').insert(row);
  }
}

async function generateEd25519Keypair(): Promise<{ publicKey: string; privateKey: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'gatewaze-newsletter-keygen-'));
  const keyPath = join(dir, 'id_ed25519');
  try {
    const result = await new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
      const proc = spawn('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-q', '-C', 'gatewaze-newsletter-deploy-key'], {});
      let stderr = '';
      proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => resolve({ exitCode: code ?? -1, stderr }));
    });
    if (result.exitCode !== 0) {
      throw new Error(`ssh-keygen failed: ${result.stderr}`);
    }
    const fs = await import('node:fs/promises');
    const [publicKey, privateKey] = await Promise.all([
      fs.readFile(`${keyPath}.pub`, 'utf8'),
      fs.readFile(keyPath, 'utf8'),
    ]);
    return { publicKey: publicKey.trim(), privateKey };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
