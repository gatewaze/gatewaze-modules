/**
 * Sync one recipe source — outer-loop parallel to lib/skills/sync-source.ts
 * per spec-ai-workflows-and-skill-interop.md §3.1 and §4.12.
 *
 * The git-plumbing + lock plumbing is identical to the skill sync;
 * only the inner walk differs (looks for `*.yaml` files instead of
 * SKILL.md directories) and the upsert hits `ai_recipes` not
 * `ai_skills`. We intentionally don't extract a generic helper — the
 * two outer loops are short and reading them side-by-side is easier
 * than chasing a parameterised abstraction.
 *
 * After all recipes in the source are parsed, we run a second pass to
 * validate sub-recipe DAGs (cycle + depth detection) per §7.4. Cycles
 * found in this pass demote the affected recipes to
 * `parse_status='refused'` with a `sub-recipe-cycle` feature.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  GitError,
  gitClone,
  gitFetchHard,
  gitRevParseHead,
} from '../skills/git-client.js';
import { decryptSecret } from '../skills/secret-shim.js';
import { recipesConfig } from './recipes-config.js';
import {
  parseRecipe,
  validateSubRecipeDag,
  type ParseRecipeResult,
  type RecipeRegistry,
} from './parse-recipe.js';

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

export interface SyncRecipeSourceArgs {
  supabase: SupabaseLike;
  sourceId: string;
  trigger: 'cron' | 'webhook' | 'manual';
  /** Operator-controlled stdio allowlist (Tier-2 cmd whitelist). */
  stdioAllowlist?: string[];
  logger?: {
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>) => void;
    error: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

export type SyncRecipeSourceResult =
  | { ok: true; commit: string; recipesIndexed: number; recipesSkipped: number; durationMs: number; warnings: string[] }
  | { ok: false; reason: string; warnings: string[] };

const PATH_PREFIX_SAFE_RE = /^[A-Za-z0-9_./-]*$/;

interface SourceRow {
  id: string;
  git_url: string;
  branch: string;
  path_prefix: string;
  auth_token_ciphertext: string | null;
  // Per-kind fast-path key (migration 026). The legacy
  // last_synced_commit column is updated alongside this one in
  // releaseLock for display continuity, but the fast-path comparison
  // MUST use the per-kind value — otherwise the recipe pass would
  // short-circuit whenever the skill pass updated last_synced_commit.
  last_synced_recipes_commit: string | null;
  sync_status: string;
  sync_lock_expires_at: string | null;
}

export async function syncRecipeSource(args: SyncRecipeSourceArgs): Promise<SyncRecipeSourceResult> {
  const start = Date.now();
  const warnings: string[] = [];
  const logger = args.logger ?? consoleLogger();

  // 1. Claim the lock atomically.
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
    .select('id, git_url, branch, path_prefix, auth_token_ciphertext, last_synced_recipes_commit, sync_status, sync_lock_expires_at')
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
    // 2. Defence-in-depth path_prefix re-validation.
    if (!isPathPrefixSafe(source.path_prefix)) {
      throw new Error(`path_prefix_invalid: ${JSON.stringify(source.path_prefix)}`);
    }

    // 3. Resolve cache dir + containment check.
    const cacheRoot = recipesConfig.recipeCacheRoot;
    const cacheDir = resolve(cacheRoot, source.id);
    if (!cacheDir.startsWith(resolve(cacheRoot) + sep) && cacheDir !== resolve(cacheRoot)) {
      throw new Error(`cache_dir_escape: ${cacheDir}`);
    }
    mkdirSync(dirname(cacheDir), { recursive: true });

    // 4. Decrypt auth token if any.
    const authToken =
      source.auth_token_ciphertext != null ? decryptSecret(source.auth_token_ciphertext) : null;
    if (source.auth_token_ciphertext && authToken == null) {
      throw new Error('auth_token_decrypt_failed');
    }

    // 5. Clone or fetch.
    const perStepTimeout = Math.max(1000, Math.floor(recipesConfig.recipeSyncTimeoutMs / 4));
    if (!existsSync(cacheDir)) {
      logger.info('recipe-source.cloning', { sourceId: source.id, url: source.git_url, branch: source.branch });
      await gitClone({ url: source.git_url, branch: source.branch, targetDir: cacheDir, authToken, timeoutMs: perStepTimeout });
    } else {
      logger.info('recipe-source.fetching', { sourceId: source.id, branch: source.branch });
      await gitFetchHard({ cwd: cacheDir, branch: source.branch, authToken, timeoutMs: perStepTimeout });
    }

    // 6. HEAD SHA fast-path. Compares against the recipe-specific
    // sync key (migration 026) so a prior skill sync that updated the
    // shared last_synced_commit can't make this pass short-circuit.
    const headSha = await gitRevParseHead({ cwd: cacheDir, timeoutMs: perStepTimeout });
    if (source.last_synced_recipes_commit === headSha) {
      await releaseLock(args.supabase, source.id, headSha, null);
      return {
        ok: true,
        commit: headSha,
        recipesIndexed: 0,
        recipesSkipped: 0,
        durationMs: Date.now() - start,
        warnings,
      };
    }

    // 7. Walk root resolution.
    const walkRoot = source.path_prefix ? resolve(cacheDir, source.path_prefix) : cacheDir;
    if (!walkRoot.startsWith(cacheDir + sep) && walkRoot !== cacheDir) {
      throw new Error(`walk_root_escape: ${walkRoot}`);
    }
    if (!existsSync(walkRoot)) {
      warnings.push(`walk_root_missing: ${source.path_prefix || '(repo root)'} not found at HEAD`);
      await deleteAllForSource(args.supabase, source.id);
      await releaseLock(args.supabase, source.id, headSha, warnings.join('; '));
      return {
        ok: true,
        commit: headSha,
        recipesIndexed: 0,
        recipesSkipped: 0,
        durationMs: Date.now() - start,
        warnings,
      };
    }

    // 8. Walk for *.yaml files. Per spec §3.3: non-recipe YAML is
    //    silently skipped (the parser triages by required fields).
    const cap = recipesConfig.maxRecipesPerSource;
    const walked = walkYamls({
      walkRoot,
      cacheDir,
      cap,
      onSymlinkEscape: (p) => warnings.push(`symlink_out_of_tree: ${p}`),
    });

    if (walked.hitCap) {
      warnings.push(`recipe_count_cap_hit: ${cap} recipes indexed; remaining skipped`);
    }

    // 9. Two-pass parse: first pass parses every file independently,
    //    second pass runs DAG validation now that all paths are known.
    const seenPaths = new Set<string>();
    let recipesIndexed = 0;
    let recipesSkipped = 0;

    // PASS 1: parse every YAML, collect results keyed by repo-relative path.
    const parsedByPath = new Map<string, ParseRecipeResult>();
    const rawByPath = new Map<string, string>();
    for (const absPath of walked.files) {
      const relPath = relative(cacheDir, absPath);

      const sizeBytes = statSync(absPath).size;
      if (sizeBytes > recipesConfig.recipeBodyMaxBytes) {
        warnings.push(`recipe_too_large: ${relPath} (${sizeBytes} > ${recipesConfig.recipeBodyMaxBytes})`);
        recipesSkipped += 1;
        continue;
      }

      let raw: string;
      try {
        raw = readFileSync(absPath, 'utf-8');
      } catch (err) {
        warnings.push(`read_failed: ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
        recipesSkipped += 1;
        continue;
      }

      const parsed = parseRecipe(relPath, raw, {
        sourceId: source.id,
        pathPrefix: source.path_prefix,
        ...(args.stdioAllowlist ? { stdioAllowlist: args.stdioAllowlist } : {}),
      });

      // Triage per spec §3.3 — `not_recipe_shaped` is a soft-skip, no row.
      if (!parsed.ok && parsed.reason === 'parse_error' && parsed.message === 'not_recipe_shaped') {
        continue;
      }
      parsedByPath.set(relPath, parsed);
      rawByPath.set(relPath, raw);
    }

    // PASS 2: cycle + depth validation over the cross-recipe DAG.
    // Recipes that pass parse but participate in a cycle get demoted
    // to refused with feature='sub-recipe-cycle'.
    const registry: RecipeRegistry = { byPath: parsedByPath };
    for (const [path, parsed] of parsedByPath) {
      if (!parsed.ok) continue;
      if (parsed.recipe.sub_recipes.length === 0) continue;
      const refusal = validateSubRecipeDag(path, registry);
      if (refusal.length > 0) {
        parsedByPath.set(path, {
          ok: false,
          reason: 'refused',
          refusal,
          partial: {
            title: parsed.recipe.title,
            description: parsed.recipe.description ?? undefined,
            instructions: parsed.recipe.instructions,
          },
        });
      }
    }

    // PASS 3: upsert all parsed rows.
    for (const [relPath, parsed] of parsedByPath) {
      seenPaths.add(relPath);
      const raw = rawByPath.get(relPath) ?? '';
      const ups = await upsertRecipe(args.supabase, source.id, relPath, headSha, parsed, raw);
      if (!ups.ok) {
        warnings.push(`upsert_failed: ${relPath}: ${ups.reason}`);
        recipesSkipped += 1;
        continue;
      }
      if (parsed.ok) {
        recipesIndexed += 1;
        for (const w of parsed.warnings) warnings.push(`${relPath}: ${w}`);
      } else if (parsed.reason === 'refused') {
        warnings.push(`${relPath}: refused (${parsed.refusal.map((r) => r.feature).join(', ')})`);
        recipesSkipped += 1;
      } else {
        warnings.push(`${relPath}: parse_error: ${parsed.message}`);
        recipesSkipped += 1;
      }
    }

    // 10. Delete stale rows.
    await deleteStaleRows(args.supabase, source.id, Array.from(seenPaths));

    // 11. Release lock with success.
    await releaseLock(args.supabase, source.id, headSha, null);

    return {
      ok: true,
      commit: headSha,
      recipesIndexed,
      recipesSkipped,
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
    logger.error('recipe-source.sync_failed', { sourceId: args.sourceId, reason });

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

// ─── Internals ───────────────────────────────────────────────────────

function isPathPrefixSafe(p: string): boolean {
  if (p === '') return true;
  if (p.startsWith('/')) return false;
  if (p.split('/').some((seg) => seg === '..')) return false;
  return PATH_PREFIX_SAFE_RE.test(p);
}

interface WalkResult {
  files: string[];
  hitCap: boolean;
}

function walkYamls(args: {
  walkRoot: string;
  cacheDir: string;
  cap: number;
  onSymlinkEscape: (path: string) => void;
}): WalkResult {
  const out: string[] = [];
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
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = relpath(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
        let real: string;
        try {
          real = realpathSync(abs);
        } catch {
          continue;
        }
        if (!real.startsWith(args.cacheDir + sep) && real !== args.cacheDir) {
          args.onSymlinkEscape(abs);
          continue;
        }
        out.push(abs);
        if (out.length >= args.cap) {
          hitCap = true;
          return { files: out, hitCap };
        }
      }
    }
  }
  return { files: out, hitCap };
}

function relpath(dir: string, name: string): string {
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/**
 * Upsert one recipe (or refused/parse_error placeholder). Mirrors the
 * skills upsert: every result type is persisted so the admin UI can
 * surface what failed.
 */
async function upsertRecipe(
  supabase: SupabaseLike,
  sourceId: string,
  filePath: string,
  commitSha: string,
  parsed: ParseRecipeResult,
  rawYaml: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    let row: Record<string, unknown>;
    if (parsed.ok) {
      row = {
        source_id: sourceId,
        file_path: filePath,
        version: parsed.recipe.version,
        title: parsed.recipe.title,
        description: parsed.recipe.description,
        instructions: parsed.recipe.instructions,
        prompt: parsed.recipe.prompt,
        parameters: parsed.recipe.parameters as unknown as Record<string, unknown>[],
        response_schema: parsed.recipe.response_schema,
        settings: parsed.recipe.settings as unknown as Record<string, unknown>,
        sub_recipe_refs: parsed.recipe.sub_recipes as unknown as Record<string, unknown>[],
        extensions: parsed.recipe.extensions as unknown as Record<string, unknown>[],
        parse_status: 'ok',
        unsupported_features: [],
        parse_warnings: parsed.warnings,
        content_hash: parsed.recipe.content_hash,
        last_commit_sha: commitSha,
        updated_at: new Date().toISOString(),
      };
    } else if (parsed.reason === 'refused') {
      const title = parsed.partial?.title ?? '(refused)';
      const instructions = parsed.partial?.instructions ?? rawYaml.slice(0, 16000);
      row = {
        source_id: sourceId,
        file_path: filePath,
        title,
        description: parsed.partial?.description ?? null,
        instructions,
        parameters: [],
        response_schema: null,
        settings: {},
        sub_recipe_refs: [],
        extensions: [],
        parse_status: 'refused',
        unsupported_features: parsed.refusal as unknown as Record<string, unknown>[],
        parse_warnings: [],
        content_hash: '',
        last_commit_sha: commitSha,
        updated_at: new Date().toISOString(),
      };
    } else {
      const title = parsed.partial?.title ?? '(parse error)';
      const instructions = parsed.partial?.instructions ?? rawYaml.slice(0, 16000);
      row = {
        source_id: sourceId,
        file_path: filePath,
        title,
        description: parsed.partial?.description ?? null,
        instructions,
        parameters: [],
        response_schema: null,
        settings: {},
        sub_recipe_refs: [],
        extensions: [],
        parse_status: 'parse_error',
        unsupported_features: [],
        parse_warnings: [parsed.message],
        content_hash: '',
        last_commit_sha: commitSha,
        updated_at: new Date().toISOString(),
      };
    }
    const res = await supabase
      .from('ai_recipes')
      .upsert(row, { onConflict: 'source_id,file_path' })
      .select('id')
      .maybeSingle();
    if (res?.error) return { ok: false, reason: String(res.error.message ?? res.error) };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function deleteStaleRows(
  supabase: SupabaseLike,
  sourceId: string,
  liveFilePaths: string[],
): Promise<void> {
  if (liveFilePaths.length === 0) {
    await supabase.from('ai_recipes').delete().eq('source_id', sourceId);
    return;
  }
  const csv = liveFilePaths.map((p) => `"${p.replace(/"/g, '\\"')}"`).join(',');
  await supabase
    .from('ai_recipes')
    .delete()
    .eq('source_id', sourceId)
    .not('file_path', 'in', `(${csv})`);
}

async function deleteAllForSource(supabase: SupabaseLike, sourceId: string): Promise<void> {
  await supabase.from('ai_recipes').delete().eq('source_id', sourceId);
}

async function releaseLock(
  supabase: SupabaseLike,
  sourceId: string,
  headSha: string,
  errorMsg: string | null,
): Promise<void> {
  await supabase
    .from('ai_agent_sources')
    .update({
      sync_status: errorMsg ? 'ok' : 'ok',
      sync_error: errorMsg,
      last_synced_at: new Date().toISOString(),
      // Per-kind key drives the fast-path; the legacy column is kept
      // in step so the admin UI's "last commit" display stays
      // accurate regardless of which pass ran last.
      last_synced_recipes_commit: headSha,
      last_synced_commit: headSha,
      sync_lock_token: null,
      sync_lock_expires_at: null,
    })
    .eq('id', sourceId);
}

function consoleLogger() {
  return {
    info: (msg: string, fields?: Record<string, unknown>) => console.log(`[ai-recipes] ${msg}`, fields ?? ''),
    warn: (msg: string, fields?: Record<string, unknown>) => console.warn(`[ai-recipes] ${msg}`, fields ?? ''),
    error: (msg: string, fields?: Record<string, unknown>) => console.error(`[ai-recipes] ${msg}`, fields ?? ''),
  };
}
