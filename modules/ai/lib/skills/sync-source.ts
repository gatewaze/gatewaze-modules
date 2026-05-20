/**
 * Sync one skill source — the work-doing half of the sync system.
 *
 * Per spec-ai-skills.md §4.2:
 *   - Claim a per-source lock (10-min TTL).
 *   - Re-validate path_prefix.
 *   - Clone if missing, else fetch + reset --hard + clean -fdx.
 *   - Fast-path on HEAD SHA unchanged.
 *   - Walk path_prefix, enforce file count + size caps, skip symlinks
 *     pointing outside the cache dir.
 *   - Parse each .md via frontmatter.ts, upsert into ai_skills.
 *   - Delete stale rows (files removed in this commit).
 *   - Release the lock, update sync_status.
 *
 * All git work goes through git-client.ts so timeouts are enforced and
 * auth tokens never appear in argv or environment leaks.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

// Reference-image caps. Migration 006 adds the bytea/mime columns;
// these limits are enforced here at sync time so a bad commit can't
// blow the row size or smuggle non-image bytes into the request to
// Gemini.
const REFERENCE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const REFERENCE_IMAGE_ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
import { randomUUID } from 'node:crypto';
import {
  GitError,
  gitClone,
  gitFetchHard,
  gitRevParseHead,
} from './git-client.js';
import { parseSkill, type ParsedSkill, type UnsupportedFeature } from './parse-skill.js';
import { skillsConfig } from './skills-config.js';
import { decryptSecret } from './secret-shim.js';

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

export interface SyncSourceArgs {
  supabase: SupabaseLike;
  sourceId: string;
  trigger: 'cron' | 'webhook' | 'manual';
  logger?: {
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
    error: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

export type SyncSourceResult =
  | { ok: true; commit: string; filesIndexed: number; filesSkipped: number; durationMs: number; warnings: string[] }
  | { ok: false; reason: string; warnings: string[] };

const PATH_PREFIX_SAFE_RE = /^[A-Za-z0-9_./-]*$/;

interface SourceRow {
  id: string;
  git_url: string;
  branch: string;
  path_prefix: string;
  auth_token_ciphertext: string | null;
  last_synced_commit: string | null;
  sync_status: string;
  sync_lock_expires_at: string | null;
}

export async function syncSource(args: SyncSourceArgs): Promise<SyncSourceResult> {
  const start = Date.now();
  const warnings: string[] = [];
  const logger = args.logger ?? consoleLogger();

  // 1. Claim the lock with an atomic update.
  const lockToken = randomUUID();
  const claimRes = await args.supabase
    .from('ai_agent_sources')
    .update({
      sync_status: 'syncing',
      sync_lock_token: lockToken,
      sync_lock_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
    .eq('id', args.sourceId)
    .or(`sync_status.neq.syncing,sync_lock_expires_at.lt.${new Date().toISOString()}`)
    .select('id, git_url, branch, path_prefix, auth_token_ciphertext, last_synced_commit, sync_status, sync_lock_expires_at')
    .maybeSingle();

  const source = claimRes?.data as SourceRow | null;
  if (!source) {
    return {
      ok: false,
      reason: 'lock_not_acquired (another worker holds it or source missing)',
      warnings,
    };
  }

  try {
    // 2. Re-validate path_prefix as defence-in-depth (CHECK already
    //    enforced at INSERT time, but we don't trust mutations).
    if (!isPathPrefixSafe(source.path_prefix)) {
      throw new Error(`path_prefix_invalid: ${JSON.stringify(source.path_prefix)}`);
    }

    // 3. Resolve cache dir.
    const cacheRoot = skillsConfig.skillCacheRoot;
    const cacheDir = resolve(cacheRoot, source.id);
    if (!cacheDir.startsWith(resolve(cacheRoot) + sep) && cacheDir !== resolve(cacheRoot)) {
      throw new Error(`cache_dir_escape: ${cacheDir}`);
    }
    mkdirSync(dirname(cacheDir), { recursive: true });

    // 4. Decrypt token if present.
    const authToken =
      source.auth_token_ciphertext != null
        ? decryptSecret(source.auth_token_ciphertext)
        : null;
    if (source.auth_token_ciphertext && authToken == null) {
      throw new Error('auth_token_decrypt_failed');
    }

    // 5. Clone or fetch.
    const perStepTimeout = Math.max(1000, Math.floor(skillsConfig.skillSyncTimeoutMs / 4));
    if (!existsSync(cacheDir)) {
      logger.info('skill-source.cloning', { sourceId: source.id, url: source.git_url, branch: source.branch });
      await gitClone({
        url: source.git_url,
        branch: source.branch,
        targetDir: cacheDir,
        authToken,
        timeoutMs: perStepTimeout,
      });
    } else {
      logger.info('skill-source.fetching', { sourceId: source.id, branch: source.branch });
      await gitFetchHard({
        cwd: cacheDir,
        branch: source.branch,
        authToken,
        timeoutMs: perStepTimeout,
      });
    }

    // 6. HEAD SHA — fast-path if unchanged.
    const headSha = await gitRevParseHead({ cwd: cacheDir, timeoutMs: perStepTimeout });
    if (source.last_synced_commit === headSha) {
      await releaseLock(args.supabase, source.id, headSha, null);
      return {
        ok: true,
        commit: headSha,
        filesIndexed: 0,
        filesSkipped: 0,
        durationMs: Date.now() - start,
        warnings,
      };
    }

    // 7. Resolve walk root + containment re-assertion.
    const walkRoot = source.path_prefix
      ? resolve(cacheDir, source.path_prefix)
      : cacheDir;
    if (!walkRoot.startsWith(cacheDir + sep) && walkRoot !== cacheDir) {
      throw new Error(`walk_root_escape: ${walkRoot}`);
    }
    if (!existsSync(walkRoot)) {
      // Source pointed at a path that doesn't exist in this commit.
      // Index nothing, delete stale rows.
      warnings.push(`walk_root_missing: ${source.path_prefix || '(repo root)'} not found at HEAD`);
      await deleteAllForSource(args.supabase, source.id);
      await releaseLock(args.supabase, source.id, headSha, warnings.join('; '));
      return {
        ok: true,
        commit: headSha,
        filesIndexed: 0,
        filesSkipped: 0,
        durationMs: Date.now() - start,
        warnings,
      };
    }

    // 8. Walk for SKILL.md directories. Per spec-ai-workflows-and-
    //    skill-interop.md §3.2: a skill is a *directory* containing
    //    SKILL.md, not a loose .md file. Sibling files in the
    //    directory become inert resource-path metadata.
    const cap = skillsConfig.maxSkillsPerSource;
    const walked = walkSkillDirectories({
      walkRoot,
      cacheDir,
      cap,
      onSymlinkEscape: (p) => warnings.push(`symlink_out_of_tree: ${p}`),
    });

    if (walked.hitCap) {
      warnings.push(`skill_count_cap_hit: ${cap} skills indexed; remaining skipped`);
    }

    // 9. Read + parse + upsert each.
    const seenDirPaths = new Set<string>();
    let filesIndexed = 0;
    let filesSkipped = 0;

    for (const skill of walked.skills) {
      const dirPath = relative(cacheDir, skill.dirAbsPath); // path relative to repo root
      seenDirPaths.add(dirPath);

      const skillMdAbs = join(skill.dirAbsPath, 'SKILL.md');
      const sizeBytes = statSync(skillMdAbs).size;
      if (sizeBytes > skillsConfig.skillBodyMaxBytes) {
        warnings.push(`file_too_large: ${dirPath}/SKILL.md (${sizeBytes} > ${skillsConfig.skillBodyMaxBytes})`);
        filesSkipped += 1;
        continue;
      }

      let raw: string;
      try {
        raw = readFileSync(skillMdAbs, 'utf-8');
      } catch (err) {
        warnings.push(`read_failed: ${dirPath}/SKILL.md: ${err instanceof Error ? err.message : String(err)}`);
        filesSkipped += 1;
        continue;
      }

      const parsed = parseSkill(skill.dirAbsPath, raw, skill.siblingFiles);

      // The new schema persists refused / parse_error skills too — the
      // operator UI surfaces them with a status badge so authors can
      // see what failed. The body is stored regardless so the admin
      // can inspect the offending content.
      const ups = await upsertSkill(args.supabase, source.id, dirPath, headSha, parsed, raw, skill.siblingFiles);
      if (!ups.ok) {
        warnings.push(`upsert_failed: ${dirPath}: ${ups.reason}`);
        filesSkipped += 1;
        continue;
      }
      if (parsed.ok) {
        filesIndexed += 1;
        for (const w of parsed.warnings) warnings.push(`${dirPath}: ${w}`);
      } else if (parsed.reason === 'refused') {
        warnings.push(`${dirPath}: refused (${parsed.refusal.map((r) => r.feature).join(', ')})`);
        filesSkipped += 1;
      } else {
        warnings.push(`${dirPath}: parse_error: ${parsed.message}`);
        filesSkipped += 1;
      }
    }

    // 10. Delete stale rows (skill dirs removed from the repo since last sync).
    await deleteStaleRows(args.supabase, source.id, Array.from(seenDirPaths));

    // 11. Release lock with success.
    await releaseLock(args.supabase, source.id, headSha, null);

    return {
      ok: true,
      commit: headSha,
      filesIndexed,
      filesSkipped,
      durationMs: Date.now() - start,
      warnings,
    };
  } catch (err) {
    const reason =
      err instanceof GitError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
        ? err.message
        : String(err);
    logger.error('skill-source.sync_failed', { sourceId: args.sourceId, reason });

    // Release the lock with error status. Best-effort — if this fails
    // the 10-min lock-expiry catches us.
    try {
      await args.supabase
        .from('ai_agent_sources')
        .update({
          sync_status: 'error',
          sync_error: reason.slice(0, 1000),
          sync_lock_token: null,
          sync_lock_expires_at: null,
        })
        .eq('id', args.sourceId);
    } catch {
      // best-effort
    }
    return { ok: false, reason, warnings };
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function isPathPrefixSafe(p: string): boolean {
  if (p === '') return true;
  if (p.startsWith('/')) return false;
  if (p.split('/').some((seg) => seg === '..')) return false;
  return PATH_PREFIX_SAFE_RE.test(p);
}

interface SkillDirEntry {
  /** Absolute filesystem path of the directory containing SKILL.md. */
  dirAbsPath: string;
  /**
   * Relative filenames inside the skill directory, excluding SKILL.md.
   * Persisted as inert `resources` metadata on the skill row.
   */
  siblingFiles: string[];
}

interface WalkResult {
  skills: SkillDirEntry[];
  hitCap: boolean;
}

/**
 * Walk for directories that contain `SKILL.md`. Per spec §3.2:
 *   - When a directory contains SKILL.md, the directory is one skill.
 *     The walk does NOT descend further (a skill cannot contain a
 *     nested skill).
 *   - Sibling files are recorded as resource paths on the row.
 *   - Directories that don't contain SKILL.md are walked recursively.
 *   - Loose `.md` files (no SKILL.md sibling) are ignored.
 *   - Symlink escapes from the cache dir are refused (mirrors the
 *     prior implementation's defence-in-depth).
 */
function walkSkillDirectories(args: {
  walkRoot: string;
  cacheDir: string;
  cap: number;
  onSymlinkEscape: (path: string) => void;
}): WalkResult {
  const out: SkillDirEntry[] = [];
  const stack: string[] = [args.walkRoot];
  let hitCap = false;

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    // First pass: does THIS directory contain SKILL.md?
    const hasSkillMd = entries.some(
      (e) => e.isFile() && e.name === 'SKILL.md',
    );

    if (hasSkillMd) {
      // Symlink check on the directory itself.
      let real: string;
      try {
        real = realpathSync(dir);
      } catch {
        continue;
      }
      if (!real.startsWith(args.cacheDir + sep) && real !== args.cacheDir) {
        args.onSymlinkEscape(dir);
        continue;
      }

      // Collect siblings recursively under the skill dir. Paths are
      // recorded relative to the skill dir so the admin UI can
      // display them as a tree. We DO descend through child dirs
      // under the skill (e.g., references/, scripts/, assets/) to
      // record their files — they're inert metadata in v1.
      const siblingFiles: string[] = [];
      collectSiblingFiles(dir, dir, siblingFiles, args.cacheDir, args.onSymlinkEscape);
      out.push({ dirAbsPath: dir, siblingFiles });
      if (out.length >= args.cap) {
        hitCap = true;
        return { skills: out, hitCap };
      }
      // Do not descend further — spec invariant: no nested skills.
      continue;
    }

    // Recurse into subdirs.
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (!entry.isDirectory()) continue;
      stack.push(join(dir, entry.name));
    }
  }
  return { skills: out, hitCap };
}

function collectSiblingFiles(
  base: string,
  current: string,
  out: string[],
  cacheDir: string,
  onSymlinkEscape: (path: string) => void,
): void {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = join(current, entry.name);
    if (entry.isDirectory()) {
      collectSiblingFiles(base, abs, out, cacheDir, onSymlinkEscape);
    } else if (entry.isFile()) {
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        continue;
      }
      if (!real.startsWith(cacheDir + sep) && real !== cacheDir) {
        onSymlinkEscape(abs);
        continue;
      }
      const rel = relative(base, abs);
      if (rel === 'SKILL.md') continue;
      out.push(rel);
    }
  }
}

interface ResolvedReferenceImage {
  bytes: Buffer;
  mime: string;
}

function readReferenceImage(args: {
  cacheDir: string;
  mdAbsPath: string;
  relativePath: string;
  onWarn: (msg: string) => void;
}): ResolvedReferenceImage | null {
  // Resolve the path relative to the .md file's directory, then
  // re-check containment against the cache dir to defeat symlink
  // escapes (same defence we use for the .md walk).
  const mdDir = dirname(args.mdAbsPath);
  const candidateAbs = resolve(mdDir, args.relativePath);
  let realPath: string;
  try {
    realPath = realpathSync(candidateAbs);
  } catch {
    args.onWarn(`reference_image_not_found: ${args.relativePath}`);
    return null;
  }
  if (!realPath.startsWith(args.cacheDir + sep) && realPath !== args.cacheDir) {
    args.onWarn(`reference_image_out_of_tree: ${args.relativePath}`);
    return null;
  }

  let size: number;
  try {
    size = statSync(realPath).size;
  } catch (err) {
    args.onWarn(`reference_image_stat_failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (size > REFERENCE_IMAGE_MAX_BYTES) {
    args.onWarn(
      `reference_image_too_large: ${args.relativePath} (${size} > ${REFERENCE_IMAGE_MAX_BYTES})`,
    );
    return null;
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(realPath);
  } catch (err) {
    args.onWarn(`reference_image_read_failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const mime = sniffImageMime(bytes, args.relativePath);
  if (!mime) {
    args.onWarn(`reference_image_unknown_mime: ${args.relativePath}`);
    return null;
  }
  if (!REFERENCE_IMAGE_ALLOWED_MIMES.has(mime)) {
    args.onWarn(`reference_image_mime_not_allowed: ${args.relativePath} (${mime})`);
    return null;
  }

  return { bytes, mime };
}

function sniffImageMime(bytes: Buffer, path: string): string | null {
  // Magic-number sniffing first; fall back to extension when the
  // header is ambiguous (e.g. some webp variants). Either alone is
  // weak; combined gives us a defensible allowlist.
  if (bytes.length >= 8) {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return 'image/png';
    }
  }
  if (bytes.length >= 3) {
    // JPEG: FF D8 FF
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'image/jpeg';
    }
  }
  if (bytes.length >= 12) {
    // WEBP: 'RIFF' .... 'WEBP'
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return 'image/webp';
    }
  }
  // Extension fallback for sniffer misses.
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return null;
}

/**
 * Upsert a parsed skill (or the row representing a refused / parse-
 * errored skill) into the new ai_skills schema. We always persist a
 * row so the operator UI can show what failed and why — the body is
 * available for inspection regardless of parse status.
 *
 * For refused / parse_error rows we still need values for the NOT NULL
 * columns (name, description, body, content_hash). We derive sane
 * fallbacks from the directory basename + raw body so the DB invariants
 * hold without losing the diagnostic value. The CHECK constraint
 * `ai_skills_name_grammar` and `ai_skills_name_matches_dir` are enforced
 * even on parse_error rows, so the fallback name MUST match. We use
 * `basename(dirPath)` as the fallback.
 */
async function upsertSkill(
  supabase: SupabaseLike,
  sourceId: string,
  dirPath: string,
  commitSha: string,
  parsed: import('./parse-skill.js').ParseSkillResult,
  rawBody: string,
  siblingFiles: string[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const dirBase = dirPath.split('/').pop() ?? dirPath;
    // The DB CHECK constraint enforces the name grammar. If the
    // directory basename doesn't match the regex we can't write a row
    // — skip rather than crash the entire sync.
    const NAME_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
    if (!NAME_REGEX.test(dirBase)) {
      return {
        ok: false,
        reason: `dir_basename_invalid: '${dirBase}' must match ^[a-z][a-z0-9]*(-[a-z0-9]+)*$`,
      };
    }

    let row: Record<string, unknown>;
    if (parsed.ok) {
      row = {
        source_id: sourceId,
        name: parsed.skill.name,
        dir_path: dirPath,
        description: parsed.skill.description,
        metadata: parsed.skill.metadata,
        resources: parsed.skill.resources,
        body: parsed.skill.body,
        body_chars: parsed.skill.body_chars,
        content_hash: parsed.skill.content_hash,
        parse_status: 'ok',
        unsupported_features: [],
        parse_warnings: parsed.warnings,
        last_commit_sha: commitSha,
        updated_at: new Date().toISOString(),
      };
    } else if (parsed.reason === 'refused') {
      row = {
        source_id: sourceId,
        name: dirBase,
        dir_path: dirPath,
        description: '(refused)',
        metadata: {},
        resources: siblingFiles,
        body: rawBody,
        body_chars: rawBody.length,
        content_hash: '',
        parse_status: 'refused',
        unsupported_features: parsed.refusal,
        parse_warnings: [],
        last_commit_sha: commitSha,
        updated_at: new Date().toISOString(),
      };
    } else {
      row = {
        source_id: sourceId,
        name: dirBase,
        dir_path: dirPath,
        description: '(parse error)',
        metadata: {},
        resources: siblingFiles,
        body: rawBody,
        body_chars: rawBody.length,
        content_hash: '',
        parse_status: 'parse_error',
        unsupported_features: [],
        parse_warnings: [parsed.message],
        last_commit_sha: commitSha,
        updated_at: new Date().toISOString(),
      };
    }

    const res = await supabase
      .from('ai_skills')
      .upsert(row, { onConflict: 'source_id,dir_path' })
      .select('id')
      .maybeSingle();
    if (res?.error) return { ok: false, reason: String(res.error.message ?? res.error) };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function deleteStaleRows(supabase: SupabaseLike, sourceId: string, liveDirPaths: string[]): Promise<void> {
  // Postgrest doesn't have a clean "NOT IN with empty list" — handle
  // both cases. When the repo has zero skill dirs, delete every row for
  // this source. When it has some, NOT-IN them.
  if (liveDirPaths.length === 0) {
    await supabase.from('ai_skills').delete().eq('source_id', sourceId);
    return;
  }
  const csv = liveDirPaths.map((p) => `"${p.replace(/"/g, '\\"')}"`).join(',');
  await supabase
    .from('ai_skills')
    .delete()
    .eq('source_id', sourceId)
    .not('dir_path', 'in', `(${csv})`);
}

async function deleteAllForSource(supabase: SupabaseLike, sourceId: string): Promise<void> {
  await supabase.from('ai_skills').delete().eq('source_id', sourceId);
}

async function releaseLock(supabase: SupabaseLike, sourceId: string, headSha: string, errorMsg: string | null): Promise<void> {
  await supabase
    .from('ai_agent_sources')
    .update({
      sync_status: errorMsg ? 'ok' : 'ok',
      sync_error: errorMsg,
      last_synced_at: new Date().toISOString(),
      last_synced_commit: headSha,
      sync_lock_token: null,
      sync_lock_expires_at: null,
    })
    .eq('id', sourceId);
}

function consoleLogger() {
  return {
    info: (msg: string, fields?: Record<string, unknown>) => console.log(`[ai-skills] ${msg}`, fields ?? ''),
    warn: (msg: string, fields?: Record<string, unknown>) => console.warn(`[ai-skills] ${msg}`, fields ?? ''),
    error: (msg: string, fields?: Record<string, unknown>) => console.error(`[ai-skills] ${msg}`, fields ?? ''),
  };
}
