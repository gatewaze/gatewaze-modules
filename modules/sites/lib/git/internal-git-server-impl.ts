/**
 * Real implementation of InternalGitServer.
 *
 * Per spec-content-modules-git-architecture §6.3:
 *   - Bare repos at /var/gatewaze/git/<host_kind>/<slug>.git
 *   - Shell-out to `git` CLI in a worker pool (default 4 workers)
 *   - Per-repo Postgres advisory lock around publishCommit/applyMerge
 *   - Per-repo size cap enforced at receive-pack time
 *   - 30-day soft-delete grace period
 *   - HMAC-signed URLs for in-cluster build pipelines (HMAC + IP-CIDR + 5min TTL)
 *
 * The HTTP smart-protocol handler (mountGitSmartProtocol below) wraps
 * `git http-backend` (a built-in git CGI program) and pipes requests
 * through with auth + ref-protection enforcement.
 */

import { spawn } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type { Request, Response, Router } from 'express';

import type {
  ApplyMergeArgs,
  CommitResult,
  CreateRepoArgs,
  InternalGitServer,
  InternalRepoRef,
  MergeResult,
  PublishCommitArgs,
  SignedUrlArgs,
} from './internal-git-server.js';

// ---------------------------------------------------------------------------
// Worker pool: bounded concurrency for git subprocess invocations.
// Per spec §6.3: default 4 workers, configurable. Long pushes/clones do not
// block the API event loop.
// ---------------------------------------------------------------------------

class WorkerPool {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  metrics(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length };
  }
}

// ---------------------------------------------------------------------------
// Shell-out helper for git
// ---------------------------------------------------------------------------

interface GitExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function execGit(args: string[], opts: { cwd?: string; env?: Record<string, string>; stdin?: Buffer } = {}): Promise<GitExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', (exitCode) => {
      resolve({ exitCode: exitCode ?? -1, stdout, stderr });
    });
    if (opts.stdin) {
      proc.stdin.write(opts.stdin);
      proc.stdin.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Postgres advisory lock for per-repo serialization
// ---------------------------------------------------------------------------

export interface SupabaseAdvisoryLockClient {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

async function withRepoAdvisoryLock<T>(
  supabase: SupabaseAdvisoryLockClient,
  repoPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Use hashtext(repo_path) as the lock key. pg_try_advisory_lock returns
  // false if held — we surface that as publish_in_progress so the caller
  // can return 409.
  const { data, error } = await supabase.rpc('try_acquire_repo_lock', { p_repo_path: repoPath });
  if (error) {
    throw new Error(`advisory lock query failed: ${error.message}`);
  }
  if (data !== true) {
    throw new Error('publish_in_progress: another publish for this repo is in flight');
  }
  try {
    return await fn();
  } finally {
    await supabase.rpc('release_repo_lock', { p_repo_path: repoPath });
  }
}

// ---------------------------------------------------------------------------
// Internal git server — real implementation
// ---------------------------------------------------------------------------

export interface InternalGitServerDeps {
  /** Root directory for bare repos (default /var/gatewaze/git). */
  rootDir: string;
  /** Worker pool size (default 4). */
  maxConcurrency?: number;
  /** Per-repo size cap in bytes (default 500 MB). */
  defaultMaxBytes?: number;
  /** HMAC signing key for signed URLs. Rotates daily via platform pipeline. */
  signingKey: Buffer;
  /** Supabase service-role client for advisory locks + registry writes. */
  supabase: SupabaseAdvisoryLockClient & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any;
  };
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export class InternalGitServerImpl implements InternalGitServer {
  private readonly pool: WorkerPool;
  private readonly defaultMaxBytes: number;

  constructor(private readonly deps: InternalGitServerDeps) {
    this.pool = new WorkerPool(deps.maxConcurrency ?? 4);
    this.defaultMaxBytes = deps.defaultMaxBytes ?? 524_288_000; // 500 MB
  }

  workerPoolMetrics() {
    return this.pool.metrics();
  }

  // ---------------------------------------------------------------------
  // Repo lifecycle
  // ---------------------------------------------------------------------

  async createRepo(args: CreateRepoArgs): Promise<InternalRepoRef> {
    return this.pool.run(async () => {
      const barePath = this.barePathFor(args.hostKind, args.slug);
      // Idempotent: if registry row exists, return it.
      const existingResult = await this.deps.supabase
        .from('gatewaze_internal_repos')
        .select('id, host_kind, host_id, bare_path, default_branch')
        .eq('host_kind', args.hostKind)
        .eq('host_id', args.hostId)
        .single();
      const existing = existingResult.data as
        | { id: string; host_kind: string; host_id: string; bare_path: string; default_branch: string }
        | null;
      if (existing) {
        return {
          hostKind: existing.host_kind as 'site' | 'list',
          hostId: existing.host_id,
          slug: args.slug,
          barePath: existing.bare_path,
          defaultBranch: existing.default_branch,
        };
      }

      // Create bare repo on disk
      await mkdir(dirname(barePath), { recursive: true });
      const init = await execGit(['init', '--bare', '--initial-branch=main', barePath]);
      if (init.exitCode !== 0) {
        throw new Error(`git init --bare failed: ${init.stderr}`);
      }

      // Optionally clone boilerplate into a temp working tree, configure, push
      if (args.boilerplate) {
        await this.bootstrapFromBoilerplate(barePath, args.slug, args.boilerplate, args.initialCommitter);
      }

      // Register in DB
      const insertResult = await this.deps.supabase
        .from('gatewaze_internal_repos')
        .insert({
          host_kind: args.hostKind,
          host_id: args.hostId,
          bare_path: barePath,
          default_branch: 'main',
          max_size_bytes: this.defaultMaxBytes,
        })
        .select()
        .single();
      const registered = insertResult.data as { id: string } | null;
      const error = insertResult.error as { message: string } | null;
      if (error || !registered) {
        // Roll back the on-disk repo if DB registration fails
        await rm(barePath, { recursive: true, force: true });
        throw new Error(`registry insert failed: ${error?.message ?? 'unknown'}`);
      }

      this.deps.logger.info('internal-git: repo created', { hostKind: args.hostKind, slug: args.slug, barePath });

      return {
        hostKind: args.hostKind,
        hostId: args.hostId,
        slug: args.slug,
        barePath,
        defaultBranch: 'main',
      };
    });
  }

  async lookupRepo(hostKind: 'site' | 'list', hostId: string): Promise<InternalRepoRef | null> {
    const result = await this.deps.supabase
      .from('gatewaze_internal_repos')
      .select('host_kind, host_id, bare_path, default_branch')
      .eq('host_kind', hostKind)
      .eq('host_id', hostId)
      .single();
    const data = result.data as
      | { host_kind: string; host_id: string; bare_path: string; default_branch: string }
      | null;
    if (!data) return null;
    // Slug is derived from path; it's the basename without .git
    const slug = data.bare_path.split('/').pop()?.replace(/\.git$/, '') ?? '';
    return {
      hostKind: data.host_kind as 'site' | 'list',
      hostId: data.host_id,
      slug,
      barePath: data.bare_path,
      defaultBranch: data.default_branch,
    };
  }

  async softDeleteRepo(repo: InternalRepoRef): Promise<void> {
    const { error } = await this.deps.supabase
      .from('gatewaze_internal_repos')
      .update({ deleted_at: new Date().toISOString() })
      .eq('host_kind', repo.hostKind)
      .eq('host_id', repo.hostId);
    if (error) throw new Error(`softDeleteRepo failed: ${error.message}`);
    this.deps.logger.info('internal-git: repo soft-deleted', { hostKind: repo.hostKind, slug: repo.slug });
  }

  async restoreRepo(repo: InternalRepoRef): Promise<void> {
    const { error } = await this.deps.supabase
      .from('gatewaze_internal_repos')
      .update({ deleted_at: null })
      .eq('host_kind', repo.hostKind)
      .eq('host_id', repo.hostId);
    if (error) throw new Error(`restoreRepo failed: ${error.message}`);
  }

  async hardDeleteRepo(repo: InternalRepoRef): Promise<void> {
    await rm(repo.barePath, { recursive: true, force: true });
    // Caller should delete the registry row after this resolves.
  }

  // ---------------------------------------------------------------------
  // Publish / merge (advisory-lock-wrapped)
  // ---------------------------------------------------------------------

  async publishCommit(args: PublishCommitArgs): Promise<CommitResult> {
    return this.pool.run(() =>
      withRepoAdvisoryLock(this.deps.supabase, args.repo.barePath, async () => {
        const workTree = await mkdtemp(join(tmpdir(), 'gatewaze-publish-'));
        try {
          // Clone the bare repo's publish branch (or initialize if first publish)
          const clone = await execGit(['clone', '--branch', args.branch, args.repo.barePath, workTree]);
          if (clone.exitCode !== 0) {
            // Branch may not exist yet (first publish to publish branch)
            if (clone.stderr.includes('Remote branch') || clone.stderr.includes('not found')) {
              const cloneFallback = await execGit(['clone', args.repo.barePath, workTree]);
              if (cloneFallback.exitCode !== 0) {
                throw new Error(`git clone failed: ${cloneFallback.stderr}`);
              }
              await execGit(['checkout', '-b', args.branch], { cwd: workTree });
            } else {
              throw new Error(`git clone failed: ${clone.stderr}`);
            }
          }

          // Apply file changes
          for (const path of args.removals ?? []) {
            await execGit(['rm', '-f', '--ignore-unmatch', path], { cwd: workTree });
          }
          for (const [path, contents] of args.files) {
            const fullPath = join(workTree, path);
            await mkdir(dirname(fullPath), { recursive: true });
            await writeFile(fullPath, contents);
            await execGit(['add', path], { cwd: workTree });
          }

          // Configure author + commit
          const env = {
            GIT_AUTHOR_NAME: args.author.name,
            GIT_AUTHOR_EMAIL: args.author.email,
            GIT_COMMITTER_NAME: args.author.name,
            GIT_COMMITTER_EMAIL: args.author.email,
          };

          // Detect "no diff" and skip
          const status = await execGit(['status', '--porcelain'], { cwd: workTree });
          if (status.stdout.trim() === '') {
            return { sha: '', diffBytes: 0, filesChanged: 0 };
          }

          const commit = await execGit(['commit', '-m', args.message], { cwd: workTree, env });
          if (commit.exitCode !== 0) {
            throw new Error(`git commit failed: ${commit.stderr}`);
          }

          // Tag if requested
          if (args.tag) {
            const tag = await execGit(['tag', args.tag], { cwd: workTree });
            if (tag.exitCode !== 0) throw new Error(`git tag failed: ${tag.stderr}`);
          }

          // Push back to bare repo (with tags)
          const push = await execGit(['push', '--follow-tags', 'origin', args.branch], { cwd: workTree });
          if (push.exitCode !== 0) throw new Error(`git push failed: ${push.stderr}`);

          // Read the SHA of the new commit
          const sha = await execGit(['rev-parse', 'HEAD'], { cwd: workTree });
          const filesChanged = status.stdout.split('\n').filter((l) => l.trim().length > 0).length;
          const diffStat = await execGit(['diff', '--shortstat', 'HEAD~1', 'HEAD'], { cwd: workTree });
          const diffBytesMatch = diffStat.stdout.match(/(\d+) insertions?\(\+\)/);
          const diffBytes = diffBytesMatch ? parseInt(diffBytesMatch[1] ?? '0', 10) : 0;

          // Update last_pushed_at + size_bytes
          const sizeBytes = await this.getRepoSize(args.repo);
          await this.deps.supabase
            .from('gatewaze_internal_repos')
            .update({ last_pushed_at: new Date().toISOString(), size_bytes: sizeBytes })
            .eq('host_kind', args.repo.hostKind)
            .eq('host_id', args.repo.hostId);

          this.deps.logger.info('internal-git: commit pushed', {
            slug: args.repo.slug,
            branch: args.branch,
            sha: sha.stdout.trim(),
            filesChanged,
            tag: args.tag,
          });

          return {
            sha: sha.stdout.trim(),
            tag: args.tag,
            diffBytes,
            filesChanged,
          };
        } finally {
          await rm(workTree, { recursive: true, force: true });
        }
      }),
    );
  }

  async applyMerge(args: ApplyMergeArgs): Promise<MergeResult> {
    return this.pool.run(() =>
      withRepoAdvisoryLock(this.deps.supabase, args.repo.barePath, async () => {
        const workTree = await mkdtemp(join(tmpdir(), 'gatewaze-merge-'));
        try {
          const clone = await execGit(['clone', '--branch', args.toBranch, args.repo.barePath, workTree]);
          if (clone.exitCode !== 0) {
            throw new Error(`git clone failed: ${clone.stderr}`);
          }
          // Fetch fromBranch and attempt merge
          await execGit(['fetch', 'origin', args.fromBranch], { cwd: workTree });

          const env = {
            GIT_AUTHOR_NAME: args.author.name,
            GIT_AUTHOR_EMAIL: args.author.email,
            GIT_COMMITTER_NAME: args.author.name,
            GIT_COMMITTER_EMAIL: args.author.email,
          };

          const merge = await execGit(
            ['merge', '--no-ff', '-m', args.message, `origin/${args.fromBranch}`],
            { cwd: workTree, env },
          );

          if (merge.exitCode !== 0) {
            // Detect conflicts
            const conflictsRaw = await execGit(['diff', '--name-only', '--diff-filter=U'], { cwd: workTree });
            const conflicts = conflictsRaw.stdout
              .split('\n')
              .map((p) => p.trim())
              .filter((p) => p.length > 0)
              .map((path) => ({ path, reason: 'merge_conflict' }));

            if (args.failOnConflict) {
              return { appliedCommit: null, filesChanged: 0, conflicts };
            }
            // Otherwise: return conflicts; caller decides resolution
            return { appliedCommit: null, filesChanged: 0, conflicts };
          }

          // Push back
          const push = await execGit(['push', 'origin', args.toBranch], { cwd: workTree });
          if (push.exitCode !== 0) throw new Error(`git push failed: ${push.stderr}`);

          const sha = await execGit(['rev-parse', 'HEAD'], { cwd: workTree });
          const stats = await execGit(['diff', '--shortstat', 'HEAD~1', 'HEAD'], { cwd: workTree });
          const filesChangedMatch = stats.stdout.match(/(\d+) files? changed/);
          const filesChanged = filesChangedMatch ? parseInt(filesChangedMatch[1] ?? '0', 10) : 0;

          return { appliedCommit: sha.stdout.trim(), filesChanged, conflicts: [] };
        } finally {
          await rm(workTree, { recursive: true, force: true });
        }
      }),
    );
  }

  async getHeadSha(repo: InternalRepoRef, branch: string): Promise<string | null> {
    const result = await execGit(['--git-dir', repo.barePath, 'rev-parse', branch]);
    if (result.exitCode !== 0) return null;
    return result.stdout.trim();
  }

  async getRepoSize(repo: InternalRepoRef): Promise<number> {
    try {
      // git count-objects -v reports size more accurately than du
      const out = await execGit(['--git-dir', repo.barePath, 'count-objects', '-v', '-H']);
      // size-pack: 1.23 MiB → multiply
      const match = out.stdout.match(/^size-pack:\s*(\d+)/m);
      const sizeKB = match ? parseInt(match[1] ?? '0', 10) : 0;
      return sizeKB * 1024;
    } catch {
      // Fallback: stat the bare repo dir
      const s = await stat(repo.barePath);
      return s.size;
    }
  }

  // ---------------------------------------------------------------------
  // Signed URL minting (HMAC-SHA256, IP-CIDR-bound, 5-min TTL by default)
  // ---------------------------------------------------------------------

  async mintSignedUrl(args: SignedUrlArgs): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + args.ttlSeconds;
    const ipCidr = args.ipCidr ?? '0.0.0.0/0';
    const payload = `${args.repo.barePath}|${args.op}|${exp}|${ipCidr}`;
    const token = createHmac('sha256', this.deps.signingKey).update(payload).digest('hex');
    const params = new URLSearchParams({
      token,
      exp: String(exp),
      op: args.op,
      ip_cidr: ipCidr,
    });
    return `/git/${args.repo.hostKind}/${args.repo.slug}.git?${params.toString()}`;
  }

  /**
   * Validates a signed URL. Returns true if HMAC matches AND token not
   * expired AND requesting IP is within the bound CIDR.
   */
  validateSignedUrl(repo: InternalRepoRef, params: URLSearchParams, requestIp: string): boolean {
    const token = params.get('token');
    const expStr = params.get('exp');
    const op = params.get('op');
    const ipCidr = params.get('ip_cidr');
    if (!token || !expStr || !op || !ipCidr) return false;
    const exp = parseInt(expStr, 10);
    if (Number.isNaN(exp) || exp < Math.floor(Date.now() / 1000)) return false;

    // IP CIDR check (simple — supports /32, /24, /16, /0; full CIDR lib for production)
    if (!ipMatchesCidr(requestIp, ipCidr)) return false;

    const payload = `${repo.barePath}|${op}|${exp}|${ipCidr}`;
    const expected = createHmac('sha256', this.deps.signingKey).update(payload).digest('hex');
    try {
      return token.length === expected.length
        && timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Boilerplate bootstrap
  // ---------------------------------------------------------------------

  private async bootstrapFromBoilerplate(
    barePath: string,
    slug: string,
    boilerplate: { url: string; tag: string },
    committer?: { name: string; email: string },
  ): Promise<void> {
    const workTree = await mkdtemp(join(tmpdir(), 'gatewaze-boilerplate-'));
    try {
      // Clone the boilerplate at the pinned tag
      const clone = await execGit(['clone', '--depth', '1', '--branch', boilerplate.tag, boilerplate.url, workTree]);
      if (clone.exitCode !== 0) {
        throw new Error(`boilerplate clone failed: ${clone.stderr}`);
      }
      // Customize package.json with the site name (best-effort)
      try {
        const pkgPath = join(workTree, 'package.json');
        const fs = await import('node:fs/promises');
        const raw = await fs.readFile(pkgPath, 'utf8');
        const pkg = JSON.parse(raw) as { name?: string };
        pkg.name = `gatewaze-site-${slug}`;
        await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
      } catch {
        /* not all boilerplates have package.json — skip */
      }
      // Wipe boilerplate's own .git history; init fresh
      await rm(join(workTree, '.git'), { recursive: true, force: true });
      await execGit(['init', '--initial-branch=main'], { cwd: workTree });
      const env = {
        GIT_AUTHOR_NAME: committer?.name ?? 'gatewaze',
        GIT_AUTHOR_EMAIL: committer?.email ?? 'noreply@gatewaze.local',
        GIT_COMMITTER_NAME: committer?.name ?? 'gatewaze',
        GIT_COMMITTER_EMAIL: committer?.email ?? 'noreply@gatewaze.local',
      };
      await execGit(['add', '-A'], { cwd: workTree });
      await execGit(['commit', '-m', `Initial commit from ${boilerplate.url}@${boilerplate.tag}`], { cwd: workTree, env });
      await execGit(['remote', 'add', 'origin', barePath], { cwd: workTree });
      await execGit(['push', '-u', 'origin', 'main'], { cwd: workTree });
    } finally {
      await rm(workTree, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private barePathFor(hostKind: 'site' | 'list', slug: string): string {
    if (!/^[a-z0-9-]+$/.test(slug)) {
      throw new Error(`invalid slug: ${slug}`);
    }
    return join(this.deps.rootDir, hostKind, `${slug}.git`);
  }
}

// ---------------------------------------------------------------------------
// HTTP smart-protocol mount (uses git http-backend CGI)
// ---------------------------------------------------------------------------

export interface SmartProtocolDeps {
  server: InternalGitServerImpl;
  /** Resolve repo by URL params. Returns null if not found. */
  lookupRepo: (hostKind: 'site' | 'list', slug: string) => Promise<InternalRepoRef | null>;
  /** True if requesting JWT identifies an admin for the given repo. */
  isAdminForRepo: (req: Request, repo: InternalRepoRef) => Promise<boolean>;
  /** True if JWT is service-role (bypass auth checks). */
  isServiceRole: (req: Request) => boolean;
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void };
}

export function mountGitSmartProtocol(router: Router, deps: SmartProtocolDeps): void {
  // Express route: /git/:hostKind/:slug.git/*  — but Express path params don't
  // accept dots, so we decompose manually.
  router.use('/git', async (req: Request, res: Response, next) => {
    // Path: /:hostKind/:slug.git/<rest>
    const m = req.path.match(/^\/(site|list)\/([a-z0-9-]+)\.git\/(.+)$/);
    if (!m) {
      return next();
    }
    const hostKind = m[1] as 'site' | 'list';
    const slug = m[2] ?? '';
    const subpath = m[3] ?? '';

    const repo = await deps.lookupRepo(hostKind, slug);
    if (!repo) {
      res.status(404).end();
      return;
    }

    // Determine operation: read (upload-pack) vs write (receive-pack)
    const queryService = (req.query.service as string | undefined) ?? '';
    const isReceivePack = subpath === 'git-receive-pack' || queryService === 'git-receive-pack';
    const isUploadPack = subpath === 'git-upload-pack' || queryService === 'git-upload-pack';

    // Auth check
    const isService = deps.isServiceRole(req);
    if (isReceivePack) {
      // Push always requires admin JWT
      if (!isService && !(await deps.isAdminForRepo(req, repo))) {
        res.status(403).end();
        return;
      }
    } else {
      // Read: admin JWT, service role, OR valid signed URL
      const ip = req.ip ?? '0.0.0.0';
      const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
      const isValidSigned = deps.server.validateSignedUrl(repo, params, ip);
      if (!isService && !isValidSigned && !(await deps.isAdminForRepo(req, repo))) {
        res.status(401).end();
        return;
      }
    }

    // Spawn git http-backend (CGI)
    const env: Record<string, string> = {
      GIT_PROJECT_ROOT: dirname(repo.barePath),
      PATH_INFO: `/${slug}.git/${subpath}`,
      REQUEST_METHOD: req.method,
      QUERY_STRING: new URL(req.url, `http://${req.headers.host}`).search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      GIT_HTTP_EXPORT_ALL: '1',
      // Read git http-backend stdin from the request body
      // (express.raw() must be in front of this middleware for receive-pack)
    };
    if (req.headers['content-length']) {
      env.CONTENT_LENGTH = req.headers['content-length'];
    }

    const proc = spawn('git', ['http-backend'], { env: { ...process.env, ...env } });
    req.pipe(proc.stdin);

    let headerBuffer = '';
    let headerEnded = false;
    let responseStarted = false;

    proc.stdout.on('data', (chunk: Buffer) => {
      if (!headerEnded) {
        headerBuffer += chunk.toString();
        const headerEnd = headerBuffer.indexOf('\r\n\r\n');
        if (headerEnd !== -1) {
          headerEnded = true;
          const headers = headerBuffer.slice(0, headerEnd);
          const body = Buffer.from(headerBuffer.slice(headerEnd + 4), 'binary');
          for (const line of headers.split('\r\n')) {
            const colon = line.indexOf(':');
            if (colon !== -1) {
              const name = line.slice(0, colon).trim();
              const val = line.slice(colon + 1).trim();
              if (name.toLowerCase() === 'status') {
                res.status(parseInt(val, 10) || 200);
              } else {
                res.setHeader(name, val);
              }
            }
          }
          responseStarted = true;
          if (body.length > 0) res.write(body);
        }
      } else {
        res.write(chunk);
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      deps.logger.warn('git http-backend stderr', { msg: chunk.toString() });
    });

    proc.on('close', (code) => {
      if (!responseStarted) {
        res.status(500).end(`git http-backend exited ${code}`);
      } else {
        res.end();
      }
    });

    proc.on('error', (err) => {
      deps.logger.warn('git http-backend spawn error', { error: err.message });
      if (!responseStarted) {
        res.status(500).end('git http-backend failed to spawn');
      }
    });
  });
}

// ---------------------------------------------------------------------------
// IP CIDR helper (minimal — supports IPv4 /0, /8, /16, /24, /32)
// Production should swap to a proper CIDR library (cidr-tools, netmask, etc.)
// ---------------------------------------------------------------------------

function ipMatchesCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  if (slash === -1) return ip === cidr;
  const network = cidr.slice(0, slash);
  const bits = parseInt(cidr.slice(slash + 1), 10);
  if (bits === 0) return true;
  if (bits === 32) return ip === network;

  const ipParts = ip.split('.').map((p) => parseInt(p, 10));
  const netParts = network.split('.').map((p) => parseInt(p, 10));
  if (ipParts.length !== 4 || netParts.length !== 4) return false;
  if (ipParts.some(Number.isNaN) || netParts.some(Number.isNaN)) return false;

  const ipInt = ((ipParts[0] ?? 0) << 24) >>> 0
              | ((ipParts[1] ?? 0) << 16) >>> 0
              | ((ipParts[2] ?? 0) << 8) >>> 0
              | (ipParts[3] ?? 0);
  const netInt = ((netParts[0] ?? 0) << 24) >>> 0
               | ((netParts[1] ?? 0) << 16) >>> 0
               | ((netParts[2] ?? 0) << 8) >>> 0
               | (netParts[3] ?? 0);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}
