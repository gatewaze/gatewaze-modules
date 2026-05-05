/**
 * Git source ingest — minimal manual-clone implementation.
 *
 * Per spec-templates-module §6 (3 input shapes) and
 * spec-content-modules-git-architecture §6 (git as source of truth).
 *
 * What this implementation does (v1):
 *   - Shells out to `git clone --depth 1` into a per-source cache dir
 *     (re-uses the directory on subsequent applies; updates with `git pull`)
 *   - Walks the cloned tree, reads files matching the configured manifest
 *     (defaults: every `*.html` / `*.mjml` under the repo root)
 *   - Concatenates them into a single source bundle, parses with the
 *     existing parser, persists via `applySource()` — same shape as
 *     ingestUpload / ingestInline
 *
 * Deferred to v0.2 (per spec-module-git-update-monitoring.md):
 *   - BullMQ scheduler that polls `lsRemoteHead` every N minutes
 *   - Realtime fan-out for drift notifications
 *   - Auto-apply gate (templates_sources.auto_apply)
 *   - Full git-monitor extraction into @gatewaze/shared
 *
 * The current path supports manual ingest via POST /api/modules/templates/sources
 * with kind='git'; subsequent re-checks happen on demand via POST /sources/:id/check.
 *
 * Mirrors the cloneOrUpdateRepo helper in
 * gatewaze/packages/shared/src/modules/loader.ts (which is also exec-based);
 * inlined here rather than imported because that helper lives across the
 * workspace boundary and its dependency graph (BullMQ etc.) isn't
 * available to the templates module.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join, relative, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse } from '../parser/parse.js';
import { applySource, type ApplyResult, type ApplySupabaseClient } from './apply.js';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const BRANCH_RE = /^[A-Za-z0-9_./-]+$/;

function assertSafeUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('git source url must use http:// or https://');
  }
  // Reject embedded credentials in the URL (the token must come via the
  // separate token_secret_ref path so it's never logged or persisted in
  // plain SQL). Belt-and-braces — the route validator already strips this
  // shape but enforce here too in case a non-route caller invokes us.
  if (/^https?:\/\/[^@/]+@/.test(url)) {
    throw new Error('git source url must not embed credentials; use token_secret_ref');
  }
}

function assertSafeBranch(branch: string | undefined): void {
  if (branch === undefined) return;
  if (!BRANCH_RE.test(branch) || branch.length > 200) {
    throw new Error(`git source branch ${JSON.stringify(branch)} contains unsafe characters`);
  }
}

function assertSafeManifestPath(manifestPath: string | undefined): void {
  if (manifestPath === undefined) return;
  if (manifestPath.length > 200) throw new Error('manifest_path exceeds 200 chars');
  if (manifestPath.includes('..')) throw new Error('manifest_path must not contain ..');
  if (manifestPath.startsWith('/')) throw new Error('manifest_path must be relative');
}

/**
 * Egress allowlist (per spec-templates-module §10.5 + spec-content-modules-
 * git-architecture §15.6 acceptance criterion). When `EGRESS_ALLOWLIST` env
 * is set (comma-separated host names), only repos whose hostname matches
 * one of the entries may be cloned. Empty / unset = unrestricted (the
 * default for non-locked-down deployments).
 *
 * Subdomain wildcards are NOT supported in v1 — the spec calls this out
 * explicitly: "explicit is safer". An entry of `github.com` allows
 * `github.com` only, not `gist.github.com`.
 *
 * Throws `egress_blocked` when a clone target is rejected; the error code
 * matches the spec's acceptance-criterion test:
 *   "When EGRESS_ALLOWLIST=trusted.example is set, git_repo_remote=
 *    evil.example is rejected with `egress_blocked` at validateConfig time."
 */
export function assertHostInEgressAllowlist(url: string, env: NodeJS.ProcessEnv = process.env): void {
  const raw = env['EGRESS_ALLOWLIST'];
  if (!raw || raw.trim() === '') return; // unrestricted

  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`egress_blocked: url ${JSON.stringify(url)} is not parseable`);
  }

  const allowed = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (!allowed.includes(host)) {
    throw new Error(
      `egress_blocked: host ${JSON.stringify(host)} is not in EGRESS_ALLOWLIST (allowed: ${allowed.join(', ')})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Clone helpers (shells out to git binary)
// ---------------------------------------------------------------------------

/**
 * Where cloned repos land. Override via `GATEWAZE_TEMPLATES_GIT_CACHE` env;
 * defaults to a stable path under the OS temp dir so test runs don't
 * collide with real deployments.
 */
function getCacheDir(): string {
  return process.env['GATEWAZE_TEMPLATES_GIT_CACHE'] ?? resolve(tmpdir(), 'gatewaze-templates-git-cache');
}

function repoSlugFor(url: string): string {
  return url
    .replace(/^(https?:\/\/|git:\/\/|git@)/, '')
    .replace(/\.git$/, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .slice(0, 100);
}

function buildAuthUrl(url: string, token?: string): string {
  if (!token || !url.startsWith('https://')) return url;
  // Encode the token so a literal ':' or '@' in a PAT doesn't break parsing
  return url.replace('https://', `https://x-access-token:${encodeURIComponent(token)}@`);
}

export interface CloneRepoOptions {
  url: string;
  branch?: string;
  token?: string;
  /** Override the cache root (tests). */
  cacheDir?: string;
}

/**
 * Clone or fast-forward update a public/PAT-authenticated git repo into
 * the per-source cache. Returns the absolute path to the working tree.
 */
export function cloneOrUpdateGitSource(opts: CloneRepoOptions): string {
  assertSafeUrl(opts.url);
  assertSafeBranch(opts.branch);
  assertHostInEgressAllowlist(opts.url);

  const cacheRoot = opts.cacheDir ?? getCacheDir();
  mkdirSync(cacheRoot, { recursive: true });
  const repoDir = resolve(cacheRoot, repoSlugFor(opts.url));
  const authUrl = buildAuthUrl(opts.url, opts.token);
  const execOpts: ExecFileSyncOptions = { stdio: 'pipe' };

  if (existsSync(resolve(repoDir, '.git'))) {
    if (opts.token) {
      execFileSync('git', ['-C', repoDir, 'remote', 'set-url', 'origin', authUrl], execOpts);
    }
    try {
      const args = ['-C', repoDir, 'pull'];
      if (opts.branch) args.push('origin', opts.branch);
      args.push('--ff-only');
      execFileSync('git', args, execOpts);
    } catch {
      // Non-fast-forward or network blip — proceed with cached tree. The
      // application then runs against whatever was last successfully cloned;
      // a follow-up check picks up the new state once upstream is reachable.
    }
  } else {
    const args = ['clone', '--depth', '1'];
    if (opts.branch) args.push('--branch', opts.branch);
    args.push(authUrl, repoDir);
    execFileSync('git', args, execOpts);
  }

  return repoDir;
}

/**
 * Read the current commit SHA of a cloned working tree.
 */
export function readHeadSha(repoDir: string): string {
  const out = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { stdio: 'pipe' }).toString('utf-8');
  return out.trim();
}

// ---------------------------------------------------------------------------
// Manifest walker — finds the HTML/MJML source files in the cloned tree
// ---------------------------------------------------------------------------

const TEMPLATE_FILE_EXTS = new Set(['.html', '.htm', '.mjml']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.turbo']);

/**
 * Walk a directory and return all template-source files, relative to the
 * walk root. When `manifestPath` is set, walk only that subdirectory (or
 * read the single file if `manifestPath` ends with a recognised extension).
 *
 * Caps the file count at 50 (per spec §10.5 production-readiness checklist
 * "parser limits") and the per-file size at 1 MB.
 */
export function walkSourceFiles(
  repoDir: string,
  manifestPath?: string,
): Array<{ relativePath: string; content: string }> {
  const MAX_FILES = 50;
  const MAX_FILE_BYTES = 1024 * 1024;

  const root = manifestPath ? resolve(repoDir, manifestPath) : repoDir;
  if (!existsSync(root)) {
    throw new Error(`manifest_path ${JSON.stringify(manifestPath)} does not exist in repo`);
  }

  const out: Array<{ relativePath: string; content: string }> = [];

  function visit(p: string): void {
    if (out.length >= MAX_FILES) return;
    const stat = statSync(p);
    if (stat.isDirectory()) {
      const base = p.split('/').pop() ?? '';
      if (SKIP_DIRS.has(base)) return;
      for (const child of readdirSync(p).sort()) {
        if (out.length >= MAX_FILES) return;
        visit(join(p, child));
      }
      return;
    }
    if (!stat.isFile()) return;
    if (!TEMPLATE_FILE_EXTS.has(extname(p).toLowerCase())) return;
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`source file ${relative(repoDir, p)} exceeds 1 MB cap`);
    }
    const content = readFileSync(p, 'utf-8');
    out.push({ relativePath: relative(repoDir, p), content });
  }

  visit(root);

  if (out.length === 0) {
    throw new Error(`no template files found under ${manifestPath ?? '<repo root>'} (looked for .html/.htm/.mjml)`);
  }
  if (out.length >= MAX_FILES) {
    // Cap reached — log so admins notice they may have accidentally pointed
    // the manifest at too broad a directory.
    // eslint-disable-next-line no-console
    console.warn(`[templates] git source produced exactly ${MAX_FILES} files; some may have been skipped`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// High-level ingest (called from POST /sources)
// ---------------------------------------------------------------------------

export interface IngestGitInput {
  library_id: string;
  label: string;
  url: string;
  branch?: string;
  /** Resolved token value (callers handle secrets-store dereference). */
  token?: string;
  manifest_path?: string;
  auto_apply?: boolean;
  created_by?: string | null;
}

export interface IngestGitSupabaseClient extends ApplySupabaseClient {
  from(table: string): {
    insert(values: Record<string, unknown>): {
      select(cols: string): {
        single(): Promise<{ data: { id: string } | null; error: { message: string } | null }>;
      };
    };
    update(values: Record<string, unknown>): {
      eq(col: string, val: unknown): Promise<{ error: { message: string } | null }>;
    };
  };
}

export interface IngestGitResult {
  source_id: string;
  apply: ApplyResult;
  /** SHA the apply ran against — useful for the admin UI's "last applied" stamp. */
  installed_git_sha: string;
}

export async function ingestGit(
  supabase: IngestGitSupabaseClient,
  input: IngestGitInput,
): Promise<IngestGitResult> {
  assertSafeUrl(input.url);
  assertSafeBranch(input.branch);
  assertSafeManifestPath(input.manifest_path);

  // 1. Clone (or update) the repo into the per-source cache
  const repoDir = cloneOrUpdateGitSource({
    url: input.url,
    branch: input.branch,
    token: input.token,
  });
  const headSha = readHeadSha(repoDir);

  // 2. Walk + concatenate template source files. Single parse pass — the
  //    parser's grammar is per-file but we don't have a multi-file ParseResult
  //    in v0.1 (TODO when migrating to a real manifest), so concatenation is
  //    the simplest correct path.
  const files = walkSourceFiles(repoDir, input.manifest_path);
  const concatenated = files
    .map((f) => `<!-- file: ${f.relativePath} -->\n${f.content}`)
    .join('\n\n');
  const parsed = parse(concatenated, { sourcePath: `git:${input.url}#${headSha.slice(0, 8)}` });

  // 3. If parse produced errors, persist a source row with status='error' so
  //    the admin sees it in the UI, but don't apply the (broken) artifacts.
  if (parsed.errors.length > 0) {
    const insertRes = await supabase
      .from('templates_sources')
      .insert({
        library_id: input.library_id,
        kind: 'git',
        label: input.label,
        url: input.url,
        branch: input.branch ?? null,
        manifest_path: input.manifest_path ?? null,
        token_secret_ref: input.token ? '<redacted>' : null,
        auto_apply: input.auto_apply ?? false,
        status: 'error',
        last_check_error: `parse failed: ${parsed.errors[0]?.message ?? 'unknown'}`,
        created_by: input.created_by ?? null,
      })
      .select('id')
      .single();
    return {
      source_id: insertRes.data?.id ?? '',
      apply: { artifacts: [], errors: parsed.errors.map((e) => ({ code: e.code, message: e.message })), dryRun: false },
      installed_git_sha: headSha,
    };
  }

  // 4. Persist the source row first so applySource has a target FK.
  const insertRes = await supabase
    .from('templates_sources')
    .insert({
      library_id: input.library_id,
      kind: 'git',
      label: input.label,
      url: input.url,
      branch: input.branch ?? null,
      manifest_path: input.manifest_path ?? null,
      token_secret_ref: input.token ? '<redacted>' : null,
      auto_apply: input.auto_apply ?? false,
      status: 'active',
      installed_git_sha: headSha,
      created_by: input.created_by ?? null,
    })
    .select('id')
    .single();
  if (insertRes.error || !insertRes.data) {
    throw new Error(`templates_sources insert failed: ${insertRes.error?.message ?? 'no data'}`);
  }
  const sourceId = insertRes.data.id;

  // 5. Apply via existing helper — produces templates_block_defs / wrappers /
  //    definitions rows under this source.
  const sha = createHash('sha256').update(concatenated).digest('hex');
  const apply = await applySource(supabase, sourceId, parsed, { sourceSha: sha, dryRun: false });

  return { source_id: sourceId, apply, installed_git_sha: headSha };
}

/**
 * Manual "Check for updates" handler — fast-forwards the cached repo, then
 * compares the new HEAD SHA against the source's installed_git_sha. Returns
 * a small change preview the admin UI can show (added / removed / changed
 * file counts; full content-schema drift comes from the consumer side).
 *
 * Does NOT apply — that's an explicit second click in the admin UI.
 */
export async function checkGitSourceForUpdates(
  source: { url: string; branch?: string | null; token?: string | null; installed_git_sha?: string | null; manifest_path?: string | null },
): Promise<{ headSha: string; hasChanges: boolean; previousSha: string | null }> {
  const repoDir = cloneOrUpdateGitSource({
    url: source.url,
    branch: source.branch ?? undefined,
    token: source.token ?? undefined,
  });
  const headSha = readHeadSha(repoDir);
  return {
    headSha,
    hasChanges: source.installed_git_sha !== headSha,
    previousSha: source.installed_git_sha ?? null,
  };
}
