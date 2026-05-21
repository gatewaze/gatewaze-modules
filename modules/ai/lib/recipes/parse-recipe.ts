/**
 * Recipe parser — Goose-compatible YAML, per spec-ai-workflows-and-
 * skill-interop.md §4.2.
 *
 * Strict. The parser refuses recipes that:
 *   - Lack `title` or `instructions` (required).
 *   - Declare Tier-3 extensions (per extension-tiers.ts).
 *   - Use model-driven branching (`summon.delegate`, conservative
 *     token match).
 *   - Reference sub-recipes that escape the source's path_prefix.
 *   - Contain sub-recipe cycles or exceed MAX_RECIPE_DEPTH.
 *   - Use the `file` input_type for parameters (no filesystem
 *     binding at runtime).
 *
 * Sub-recipe resolution is two-pass: pass 1 parses every YAML in the
 * source, pass 2 resolves `sub_recipes[].path` references against the
 * pass-1 map and detects cycles.
 *
 * Output mirrors ParseSkillResult's shape — discriminated union on
 * `ok`, with `refused` carrying a structured UnsupportedFeature list
 * and `parse_error` carrying a human-readable message.
 */

import { load as loadYaml, YAMLException } from 'js-yaml';
import { createHash } from 'node:crypto';
import { dirname, normalize, posix, relative, resolve as pathResolve } from 'node:path';

import { classifyExtension, type ExtensionInput } from './extension-tiers.js';

/** Max nesting depth of sub-recipe DAG. Per spec §7.4. */
export const MAX_RECIPE_DEPTH = 6;

/** Max fanout per sub-recipe step (per spec §4.4 + §9). */
export const MAX_RECIPE_FANOUT = 5;

export type ParseRecipeResult =
  | { ok: true; recipe: ParsedRecipe; warnings: string[] }
  | { ok: false; reason: 'refused'; refusal: UnsupportedFeature[]; partial?: PartialParsedRecipe }
  | { ok: false; reason: 'parse_error'; message: string; partial?: PartialParsedRecipe };

export interface PartialParsedRecipe {
  /** Whichever required-field values WERE parsed (for partial-row indexing). */
  title?: string;
  description?: string;
  instructions?: string;
}

export interface ParsedRecipe {
  /** Optional schema-version tag from the recipe YAML (e.g. "1.0.0"). */
  version: string | null;
  title: string;
  description: string | null;
  /** System prompt (Goose convention). Required, ≤16 KiB. */
  instructions: string;
  /**
   * Optional initial user message (Goose `prompt:` field). When set,
   * the executor uses this as the user turn instead of a generic
   * placeholder. Subject to the same `{{ param }}` substitution as
   * `instructions`.
   */
  prompt: string | null;
  parameters: ParsedParameter[];
  response_schema: Record<string, unknown> | null;
  settings: ParsedSettings;
  sub_recipes: ParsedSubRecipeRef[];
  extensions: ParsedExtension[];
  /**
   * Skill references to auto-load at run time. Each entry is a skill
   * name (matched against ai_skills.name) or a `source/path` form for
   * disambiguation when multiple agent sources expose skills with the
   * same name. The Goose-routed wrapper looks each up in ai_skills,
   * prepends the resolved body to the recipe's instructions, and
   * substitutes the in-house executor's "auto-loaded skill" feature
   * that recipes were originally written against.
   */
  skills: string[];
  content_hash: string;
}

export interface ParsedParameter {
  key: string;
  input_type: 'string' | 'number' | 'boolean' | 'date' | 'select';
  requirement: 'required' | 'optional';
  description?: string;
  default?: unknown;
  options?: string[];
}

export interface ParsedSettings {
  goose_provider: 'anthropic' | 'openai' | 'gemini' | 'auto' | null;
  goose_model: string | null;
}

export interface ParsedSubRecipeRef {
  name: string;
  /** Resolved repo-relative path (post path_prefix + traversal check). */
  path: string;
  /** Raw `values:` block as authored. Substitution happens at run time. */
  values: Record<string, unknown>;
  activation_key: string | null;
  activation_value: string | null;
}

export interface ParsedExtension {
  type: string;
  name?: string;
  tier: 1 | 2 | 3;
  /** Raw block, preserved for the executor to read auth / uri / cmd etc. */
  raw: Record<string, unknown>;
}

export interface UnsupportedFeature {
  feature:
    | 'shell-injection'
    | 'argument-substitution'
    | 'env-substitution'
    | 'arguments-field'
    | 'tier-3-extension'
    | 'cross-source-sub-recipe'
    | 'sub-recipe-cycle'
    | 'unknown-model'
    | 'unknown-provider'
    | 'model-driven-branching'
    | 'file-input-type'
    | 'sub-recipe-depth-exceeded';
  location: { line: number; col: number; snippet: string };
  details?: string;
}

interface ParseRecipeContext {
  sourceId: string;
  pathPrefix: string;
  /** Pre-validated stdio allowlist from config/ai-recipes.yaml. */
  stdioAllowlist?: string[];
}

/**
 * Parse a single recipe YAML. The path-prefix check + cycle detection
 * across sub-recipes is performed by the caller (sync worker) via
 * `validateSubRecipeRefs` since cross-file resolution requires the
 * full source's recipe inventory.
 */
export function parseRecipe(
  recipeYamlPath: string,
  recipeYamlRaw: string,
  ctx: ParseRecipeContext,
): ParseRecipeResult {
  // ── Step 1: YAML parse ──────────────────────────────────────────
  let doc: unknown;
  try {
    doc = loadYaml(recipeYamlRaw, { schema: undefined });
  } catch (err) {
    if (err instanceof YAMLException) {
      return { ok: false, reason: 'parse_error', message: `yaml: ${err.message}` };
    }
    return { ok: false, reason: 'parse_error', message: `yaml: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, reason: 'parse_error', message: 'recipe root must be a YAML mapping' };
  }
  const d = doc as Record<string, unknown>;

  // ── Step 2: triage — does this file even look like a recipe? ────
  // Per spec §3.3: a YAML file with NONE of the recipe-shaped fields
  // is treated as non-recipe (Helm chart, CI config, etc.) and the
  // walker silently ignores it. A file with SOME recipe-shaped fields
  // but missing required ones is a parse_error (catches typos like
  // `tittle:`).
  const hasShape = [
    'title',
    'instructions',
    'parameters',
    'sub_recipes',
    // Goose recipes always carry `version` + `prompt`; either alone is
    // a strong enough signal that this is meant to be a recipe.
    'version',
    'prompt',
  ].some((k) => k in d);
  if (!hasShape) {
    return { ok: false, reason: 'parse_error', message: 'not_recipe_shaped' };
  }

  // ── Step 3: required fields ─────────────────────────────────────
  const partial: PartialParsedRecipe = {};
  if (typeof d.title !== 'string' || d.title.trim().length === 0) {
    return {
      ok: false,
      reason: 'parse_error',
      message: 'recipe.title required (non-empty string)',
      partial,
    };
  }
  if (d.title.length > 200) {
    return { ok: false, reason: 'parse_error', message: 'recipe.title exceeds 200 chars', partial };
  }
  partial.title = d.title;

  if (typeof d.description === 'string') partial.description = d.description;

  if (typeof d.instructions !== 'string' || d.instructions.trim().length === 0) {
    return {
      ok: false,
      reason: 'parse_error',
      message: 'recipe.instructions required (non-empty string)',
      partial,
    };
  }
  if (d.instructions.length > 16384) {
    return {
      ok: false,
      reason: 'parse_error',
      message: 'recipe.instructions exceeds 16 KiB',
      partial,
    };
  }
  partial.instructions = d.instructions;

  // ── Step 4: Tier-3 refusal scans on instructions ────────────────
  // §4.6 — conservative summon.delegate token-pattern match. False
  // positives are intentional; better to refuse one well-meaning
  // mention in prose than to silently allow model-driven branching.
  const refusals: UnsupportedFeature[] = [];
  scanInstructionsForRefusals(d.instructions, refusals);

  // ── Step 5: parameters ──────────────────────────────────────────
  const warnings: string[] = [];
  const parameters: ParsedParameter[] = [];
  if (d.parameters !== undefined) {
    if (!Array.isArray(d.parameters)) {
      return { ok: false, reason: 'parse_error', message: 'recipe.parameters must be an array', partial };
    }
    for (const [i, raw] of d.parameters.entries()) {
      if (!raw || typeof raw !== 'object') {
        return {
          ok: false,
          reason: 'parse_error',
          message: `recipe.parameters[${i}]: must be a mapping`,
          partial,
        };
      }
      const p = raw as Record<string, unknown>;
      const key = p.key;
      if (typeof key !== 'string' || !/^[a-z][a-z0-9_]*$/.test(key) || key.length > 64) {
        return {
          ok: false,
          reason: 'parse_error',
          message: `recipe.parameters[${i}].key '${String(key)}' must match ^[a-z][a-z0-9_]*$ (≤64)`,
          partial,
        };
      }
      const inputType = (typeof p.input_type === 'string' ? p.input_type : 'string') as ParsedParameter['input_type'];
      if (!['string', 'number', 'boolean', 'date', 'select'].includes(inputType)) {
        if (inputType === ('file' as ParsedParameter['input_type'])) {
          refusals.push({
            feature: 'file-input-type',
            location: { line: 0, col: 0, snippet: `parameters[${i}].input_type: file` },
            details: `parameter '${key}' uses file input_type which has no filesystem binding at runtime`,
          });
        } else {
          return {
            ok: false,
            reason: 'parse_error',
            message: `recipe.parameters[${i}].input_type '${String(inputType)}' invalid`,
            partial,
          };
        }
      }
      let requirement: ParsedParameter['requirement'] = 'optional';
      const rawReq = typeof p.requirement === 'string' ? p.requirement : 'optional';
      if (rawReq === 'required') requirement = 'required';
      else if (rawReq === 'optional') requirement = 'optional';
      else if (rawReq === 'user_prompt') {
        // §4.2: coerce user_prompt → required with a warning.
        requirement = 'required';
        warnings.push(
          `parameter '${key}': user_prompt coerced to required (no interactive surface in Gatewaze)`,
        );
      } else {
        return {
          ok: false,
          reason: 'parse_error',
          message: `recipe.parameters[${i}].requirement '${rawReq}' invalid`,
          partial,
        };
      }
      const parsedParam: ParsedParameter = {
        key,
        input_type: inputType as ParsedParameter['input_type'],
        requirement,
      };
      if (typeof p.description === 'string') parsedParam.description = p.description;
      if (p.default !== undefined) parsedParam.default = p.default;
      if (inputType === 'select') {
        if (!Array.isArray(p.options) || p.options.some((o) => typeof o !== 'string')) {
          return {
            ok: false,
            reason: 'parse_error',
            message: `recipe.parameters[${i}].options must be a string[] when input_type=select`,
            partial,
          };
        }
        parsedParam.options = p.options as string[];
      }
      parameters.push(parsedParam);
    }
  }

  // ── Step 6: parameter substitution in instructions ──────────────
  // We don't substitute values here (caller does that at run time);
  // we just validate that every {{ ref }} in instructions matches a
  // declared parameter. Unknown refs are a parse error.
  const refRegex = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  const declaredKeys = new Set(parameters.map((p) => p.key));
  let m: RegExpExecArray | null;
  while ((m = refRegex.exec(d.instructions)) !== null) {
    if (!declaredKeys.has(m[1]!)) {
      return {
        ok: false,
        reason: 'parse_error',
        message: `recipe.instructions references undeclared parameter '{{ ${m[1]} }}'`,
        partial,
      };
    }
  }

  // ── Step 7: settings ────────────────────────────────────────────
  const settings: ParsedSettings = { goose_provider: null, goose_model: null };
  if (d.settings !== undefined) {
    if (!d.settings || typeof d.settings !== 'object' || Array.isArray(d.settings)) {
      return { ok: false, reason: 'parse_error', message: 'recipe.settings must be a mapping', partial };
    }
    const s = d.settings as Record<string, unknown>;
    if (s.goose_provider !== undefined) {
      const p = s.goose_provider;
      if (typeof p !== 'string' || !['anthropic', 'openai', 'gemini', 'auto'].includes(p)) {
        return {
          ok: false,
          reason: 'parse_error',
          message: `recipe.settings.goose_provider '${String(p)}' must be anthropic|openai|gemini|auto`,
          partial,
        };
      }
      settings.goose_provider = p as ParsedSettings['goose_provider'];
      if (p === 'auto') {
        // §4.2: warn that `auto` resolution differs from Goose locally.
        warnings.push(
          'settings.goose_provider=auto: Gatewaze walks the use-case allowed_models; this may differ from local Goose',
        );
      }
    }
    if (s.goose_model !== undefined) {
      if (typeof s.goose_model !== 'string' || s.goose_model.length === 0) {
        return {
          ok: false,
          reason: 'parse_error',
          message: `recipe.settings.goose_model must be a non-empty string`,
          partial,
        };
      }
      settings.goose_model = s.goose_model;
    }
  }

  // ── Step 8: response.json_schema ────────────────────────────────
  let responseSchema: Record<string, unknown> | null = null;
  if (d.response !== undefined) {
    const r = d.response as Record<string, unknown> | null;
    if (r && typeof r === 'object' && r.json_schema !== undefined) {
      if (!r.json_schema || typeof r.json_schema !== 'object' || Array.isArray(r.json_schema)) {
        return {
          ok: false,
          reason: 'parse_error',
          message: 'recipe.response.json_schema must be a JSON Schema object',
          partial,
        };
      }
      responseSchema = r.json_schema as Record<string, unknown>;
    }
  }

  // ── Step 9: sub_recipes (path resolution + scoping) ─────────────
  const subRecipes: ParsedSubRecipeRef[] = [];
  if (d.sub_recipes !== undefined) {
    if (!Array.isArray(d.sub_recipes)) {
      return { ok: false, reason: 'parse_error', message: 'recipe.sub_recipes must be an array', partial };
    }
    const sub = parseSubRecipes(d.sub_recipes, recipeYamlPath, ctx);
    if (!sub.ok) return sub;
    subRecipes.push(...sub.refs);
  }

  // ── Step 10: extensions (tier classification) ───────────────────
  const extensions: ParsedExtension[] = [];
  if (d.extensions !== undefined) {
    if (!Array.isArray(d.extensions)) {
      return { ok: false, reason: 'parse_error', message: 'recipe.extensions must be an array', partial };
    }
    for (const [i, rawExt] of d.extensions.entries()) {
      if (!rawExt || typeof rawExt !== 'object') {
        return {
          ok: false,
          reason: 'parse_error',
          message: `recipe.extensions[${i}] must be a mapping`,
          partial,
        };
      }
      const e = rawExt as Record<string, unknown>;
      const cls = classifyExtension({
        type: typeof e.type === 'string' ? e.type : undefined,
        name: typeof e.name === 'string' ? e.name : undefined,
        uses: Array.isArray(e.uses) ? (e.uses as unknown[]).filter((u): u is string => typeof u === 'string') : undefined,
        cmd: typeof e.cmd === 'string' ? e.cmd : undefined,
        stdioAllowlist: ctx.stdioAllowlist,
      });
      if (cls.tier === 3) {
        // Map classifier-specific refusal keys down to the parser's
        // union. The classifier knows about more nuanced refusals
        // (desktop-extension, stdio-not-allowlisted, etc.) but the
        // unsupported_features storage shape is a smaller, stable
        // enum — preserve the nuance in `details` so the admin UI
        // can show authors the specific reason.
        const feature: UnsupportedFeature['feature'] =
          cls.refusalFeature === 'model-driven-branching'
            ? 'model-driven-branching'
            : 'tier-3-extension';
        const classifierLabel = cls.refusalFeature && cls.refusalFeature !== 'tier-3-extension'
          ? `${cls.refusalFeature}: `
          : '';
        refusals.push({
          feature,
          location: { line: 0, col: 0, snippet: `extensions[${i}]: ${JSON.stringify(e).slice(0, 80)}` },
          details: `${classifierLabel}${cls.details ?? ''}`,
        });
      }
      extensions.push({
        type: typeof e.type === 'string' ? e.type : '',
        name: typeof e.name === 'string' ? e.name : undefined,
        tier: cls.tier,
        raw: e,
      });
    }
  }

  if (refusals.length > 0) {
    return { ok: false, reason: 'refused', refusal: refusals, partial };
  }

  // ── version (optional, ≤32 chars) ───────────────────────────────
  let version: string | null = null;
  if (d.version !== undefined) {
    if (typeof d.version !== 'string') {
      return {
        ok: false,
        reason: 'parse_error',
        message: `recipe.version must be a string (got ${typeof d.version})`,
        partial,
      };
    }
    if (d.version.length > 32) {
      return {
        ok: false,
        reason: 'parse_error',
        message: `recipe.version exceeds 32 chars`,
        partial,
      };
    }
    version = d.version;
  }

  // ── prompt (optional initial user message; ≤16 KiB) ─────────────
  // Substitution rules match `instructions`.
  let prompt: string | null = null;
  if (d.prompt !== undefined) {
    if (typeof d.prompt !== 'string') {
      return {
        ok: false,
        reason: 'parse_error',
        message: `recipe.prompt must be a string (got ${typeof d.prompt})`,
        partial,
      };
    }
    if (d.prompt.length > 16384) {
      return {
        ok: false,
        reason: 'parse_error',
        message: `recipe.prompt exceeds 16 KiB`,
        partial,
      };
    }
    // Same {{ param }} validation as instructions.
    let pm: RegExpExecArray | null;
    const pRef = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
    while ((pm = pRef.exec(d.prompt)) !== null) {
      if (!declaredKeys.has(pm[1]!)) {
        return {
          ok: false,
          reason: 'parse_error',
          message: `recipe.prompt references undeclared parameter '{{ ${pm[1]} }}'`,
          partial,
        };
      }
    }
    prompt = d.prompt;
  }

  // ── Step 11: skills (auto-loader references) ────────────────────
  // Optional `skills: [<name>, ...]` block. Recipes that previously
  // relied on the in-house TS executor's "auto-loaded skill" feature
  // (e.g. "Follow the daily-briefing-research skill") can list those
  // skills explicitly here so the Goose-routed wrapper resolves and
  // inlines them. Backwards-compatible: missing => empty list.
  let skills: string[] = [];
  if (d.skills !== undefined) {
    if (!Array.isArray(d.skills)) {
      return { ok: false, reason: 'parse_error', message: 'recipe.skills must be an array of strings', partial };
    }
    for (const [i, raw] of d.skills.entries()) {
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        return {
          ok: false,
          reason: 'parse_error',
          message: `recipe.skills[${i}] must be a non-empty string`,
          partial,
        };
      }
    }
    skills = (d.skills as string[]).map((s) => s.trim());
  }

  return {
    ok: true,
    recipe: {
      version,
      title: d.title,
      description: typeof d.description === 'string' ? d.description : null,
      instructions: d.instructions,
      prompt,
      parameters,
      response_schema: responseSchema,
      settings,
      sub_recipes: subRecipes,
      extensions,
      skills,
      content_hash: createHash('sha256').update(recipeYamlRaw, 'utf-8').digest('hex'),
    },
    warnings,
  };
}

// ─── Sub-recipe path resolution + scoping ────────────────────────────

function parseSubRecipes(
  raw: unknown[],
  recipeYamlPath: string,
  ctx: ParseRecipeContext,
):
  | { ok: true; refs: ParsedSubRecipeRef[] }
  | { ok: false; reason: 'parse_error'; message: string }
  | { ok: false; reason: 'refused'; refusal: UnsupportedFeature[] } {
  const refs: ParsedSubRecipeRef[] = [];
  const refusal: UnsupportedFeature[] = [];

  for (const [i, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object') {
      return {
        ok: false,
        reason: 'parse_error',
        message: `recipe.sub_recipes[${i}] must be a mapping`,
      };
    }
    const sr = entry as Record<string, unknown>;
    if (typeof sr.name !== 'string' || sr.name.length === 0) {
      return {
        ok: false,
        reason: 'parse_error',
        message: `recipe.sub_recipes[${i}].name required`,
      };
    }
    if (typeof sr.path !== 'string' || sr.path.length === 0) {
      return {
        ok: false,
        reason: 'parse_error',
        message: `recipe.sub_recipes[${i}].path required`,
      };
    }

    // Resolve relative to the parent recipe's directory using POSIX
    // path semantics (recipes are repo-paths, not OS paths). Then
    // re-check that the resolved path stays within path_prefix.
    const parentDir = posix.dirname(recipeYamlPath);
    const resolvedPath = posix.normalize(posix.join(parentDir, sr.path));
    if (resolvedPath.startsWith('..') || resolvedPath.startsWith('/')) {
      refusal.push({
        feature: 'cross-source-sub-recipe',
        location: { line: 0, col: 0, snippet: `sub_recipes[${i}].path: ${sr.path}` },
        details: `resolved path '${resolvedPath}' escapes the source root`,
      });
      continue;
    }
    if (ctx.pathPrefix && !pathIsWithinPrefix(resolvedPath, ctx.pathPrefix)) {
      refusal.push({
        feature: 'cross-source-sub-recipe',
        location: { line: 0, col: 0, snippet: `sub_recipes[${i}].path: ${sr.path}` },
        details: `resolved path '${resolvedPath}' is outside source path_prefix '${ctx.pathPrefix}'`,
      });
      continue;
    }

    const values =
      sr.values && typeof sr.values === 'object' && !Array.isArray(sr.values)
        ? (sr.values as Record<string, unknown>)
        : {};

    const activationKey =
      typeof sr.activation_key === 'string' && sr.activation_key.length > 0 ? sr.activation_key : null;
    const activationValue =
      typeof sr.activation_value === 'string' && sr.activation_value.length > 0 ? sr.activation_value : null;
    if (activationKey && activationValue === null) {
      return {
        ok: false,
        reason: 'parse_error',
        message: `recipe.sub_recipes[${i}]: activation_key set without activation_value`,
      };
    }

    refs.push({
      name: sr.name,
      path: resolvedPath,
      values,
      activation_key: activationKey,
      activation_value: activationValue,
    });
  }

  if (refusal.length > 0) {
    return { ok: false, reason: 'refused', refusal };
  }
  return { ok: true, refs };
}

function pathIsWithinPrefix(p: string, prefix: string): boolean {
  const normPrefix = prefix.replace(/\/+$/, '');
  if (normPrefix === '') return true;
  return p === normPrefix || p.startsWith(normPrefix + '/');
}

// ─── Instruction-body refusal scans ──────────────────────────────────

function scanInstructionsForRefusals(text: string, out: UnsupportedFeature[]): void {
  // Conservative summon.delegate detection per §4.6.
  const delegatePatterns = [
    /\bsummon\.delegate\b/g,
    /\bsummon_delegate\b/g,
    /\bdelegate\s*\(/g,
  ];
  for (const re of delegatePatterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const loc = lineColOf(text, match.index);
      out.push({
        feature: 'model-driven-branching',
        location: { line: loc.line, col: loc.col, snippet: text.slice(match.index, match.index + 60) },
        details: 'recipe.instructions references summon.delegate (model-driven branching)',
      });
      return; // one match is enough to refuse
    }
  }
}

function lineColOf(text: string, index: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

// ─── Cross-recipe validation helpers ─────────────────────────────────
// These run AFTER all recipes in a source are parsed, to catch cycles
// and dangling sub_recipe references.

export interface RecipeRegistry {
  /** Map of repo-relative file_path → parse result. */
  byPath: Map<string, ParseRecipeResult>;
}

/**
 * Walk the sub-recipe DAG starting at `rootPath` and detect cycles +
 * depth violations. Returns refusals when violations are detected;
 * empty list otherwise.
 */
export function validateSubRecipeDag(
  rootPath: string,
  registry: RecipeRegistry,
): UnsupportedFeature[] {
  const refusals: UnsupportedFeature[] = [];
  const stack: string[] = [];

  const visit = (path: string, depth: number): void => {
    if (stack.includes(path)) {
      refusals.push({
        feature: 'sub-recipe-cycle',
        location: { line: 0, col: 0, snippet: `cycle through ${path}` },
        details: `path chain: ${[...stack, path].join(' -> ')}`,
      });
      return;
    }
    if (depth > MAX_RECIPE_DEPTH) {
      refusals.push({
        feature: 'sub-recipe-depth-exceeded',
        location: { line: 0, col: 0, snippet: `depth ${depth} at ${path}` },
        details: `MAX_RECIPE_DEPTH=${MAX_RECIPE_DEPTH} exceeded at ${path}`,
      });
      return;
    }
    const entry = registry.byPath.get(path);
    if (!entry || !entry.ok) return;
    stack.push(path);
    for (const sub of entry.recipe.sub_recipes) {
      visit(sub.path, depth + 1);
    }
    stack.pop();
  };

  visit(rootPath, 0);
  return refusals;
}
