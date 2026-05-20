/**
 * Resolve the system prompt + kickoff message for an ai_use_case AND
 * snapshot the provenance so callers can persist it on the resulting
 * ai_messages row.
 *
 * Per migration 008_ai_use_cases_skill_ref:
 *   - If `skill_source_id` + `skill_path` are set AND a matching ai_skills
 *     row exists, the skill's `body` becomes the system prompt. This is
 *     the path that lets operators version-control prompts via a git repo.
 *   - Otherwise the inline `system_prompt` column is used (operator-edited
 *     directly in the admin UI).
 *   - `kickoff_message` is the initial user turn for autopilot triggers
 *     (daily-briefing "Run research", future "Run on all tabs"). It is
 *     never sourced from a skill — kickoffs are intentionally short.
 *
 * `skill_path` is matched against `ai_skills.dir_path` (the agentskills.io
 * directory-as-skill identifier). For tolerance with legacy use-case rows
 * that still carry a `<name>.md` or bare `<name>` shape, we also fall
 * back to matching by `ai_skills.name` (the agentskills.io basename
 * invariant guarantees uniqueness of name within a source).
 *
 * Callers should treat both fields as "may be empty string" — that's the
 * documented "no prompt configured" state, not an error.
 */

import { createHash } from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supabase = { from(table: string): any };

export interface ReferenceImage {
  mimeType: string;
  /** Base64-encoded image bytes. */
  base64: string;
}

/**
 * Provenance of the resolved system prompt + kickoff. Persisted onto
 * ai_messages.prompt_source so the chat widget's "Run details" panel +
 * audit queries can show which version was used for any past turn.
 *
 * Shape mirrors migration 023's column comment.
 */
export interface PromptSource {
  use_case: string;
  system_prompt: {
    kind: 'skill' | 'recipe' | 'inline' | 'fallback' | 'empty';
    content_hash: string;
    char_count: number;
    skill?: {
      source_id: string;
      source_label: string | null;
      name: string;
      dir_path: string;
      content_hash: string;
      last_commit_sha: string;
    };
    recipe?: {
      source_id: string;
      source_label: string | null;
      recipe_id: string;
      title: string;
      file_path: string;
      content_hash: string;
      last_commit_sha: string;
    };
    /** Set for kind='fallback' so the UI can label the deprecated path. */
    note?: string;
  };
  kickoff_message: {
    kind: 'inline' | 'empty';
    char_count: number;
  };
}

export interface UseCasePrompt {
  systemPrompt: string;
  kickoffMessage: string;
  /**
   * Reference images carried by the bound skill (e.g. style anchors for
   * image-gen use cases). Empty array when the use case has no skill
   * bound, the skill has no reference image, or the skill row is
   * missing. Consumers pass these to image generators as conditioning.
   */
  referenceImages: ReferenceImage[];
  /**
   * Which path produced systemPrompt — useful for logging and for the
   * caller's branching ('recipe' means the caller should dispatch
   * ai:run-recipe via dispatchUseCaseRecipeRun rather than using
   * systemPrompt directly).
   */
  source: 'skill' | 'recipe' | 'inline' | 'empty';
  /**
   * Structured provenance the worker persists onto ai_messages.prompt_source.
   * Always set; even an empty resolution carries kind='empty' so the
   * audit trail is complete.
   */
  promptSource: PromptSource;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

export async function resolveUseCasePrompt(
  supabase: Supabase,
  useCaseId: string,
): Promise<UseCasePrompt> {
  const uc = await supabase
    .from('ai_use_cases')
    .select('system_prompt, kickoff_message, skill_source_id, skill_path, recipe_source_id, recipe_file_path')
    .eq('id', useCaseId)
    .maybeSingle();
  if (uc.error || !uc.data) {
    return {
      systemPrompt: '',
      kickoffMessage: '',
      referenceImages: [],
      source: 'empty',
      promptSource: emptyProvenance(useCaseId),
    };
  }
  const row = uc.data as {
    system_prompt: string | null;
    kickoff_message: string | null;
    skill_source_id: string | null;
    skill_path: string | null;
    recipe_source_id: string | null;
    recipe_file_path: string | null;
  };
  const kickoffMessage = row.kickoff_message ?? '';

  // Recipe binding wins when set. Migration 025 enforces skill XOR
  // recipe via CHECK constraint, so we only need to check one. The
  // caller is expected to branch on source==='recipe' and dispatch
  // ai:run-recipe via dispatchUseCaseRecipeRun — systemPrompt is left
  // empty because the recipe's instructions/prompt run inside the
  // recipe executor, not on the caller's chat turn.
  if (row.recipe_source_id && row.recipe_file_path) {
    const recipe = await lookupRecipe(supabase, row.recipe_source_id, row.recipe_file_path);
    if (recipe && recipe.parse_status === 'ok') {
      const sourceLabel = await lookupSourceLabel(supabase, row.recipe_source_id);
      return {
        systemPrompt: '',
        kickoffMessage,
        referenceImages: [],
        source: 'recipe',
        promptSource: {
          use_case: useCaseId,
          system_prompt: {
            kind: 'recipe',
            content_hash: recipe.content_hash,
            char_count: recipe.instructions.length,
            recipe: {
              source_id: row.recipe_source_id,
              source_label: sourceLabel,
              recipe_id: recipe.id,
              title: recipe.title,
              file_path: recipe.file_path,
              content_hash: recipe.content_hash,
              last_commit_sha: recipe.last_commit_sha,
            },
          },
          kickoff_message: kickoffMessage.length > 0
            ? { kind: 'inline', char_count: kickoffMessage.length }
            : { kind: 'empty', char_count: 0 },
        },
      };
    }
    // Recipe bound but missing/refused/parse_error — fall through to
    // inline/empty so the operator sees "no prompt configured" rather
    // than the run silently using a different path. The caller still
    // sees source==='inline'|'empty' and won't dispatch ai:run-recipe.
  }

  if (row.skill_source_id && row.skill_path) {
    const skill = await lookupSkill(supabase, row.skill_source_id, row.skill_path);
    if (skill && typeof skill.body === 'string' && skill.body.trim().length > 0) {
      const sourceLabel = await lookupSourceLabel(supabase, row.skill_source_id);
      const referenceImages = extractReferenceImages(
        skill.reference_image_bytes,
        skill.reference_image_mime,
      );
      const resolvedHash = sha256(skill.body);
      return {
        systemPrompt: skill.body,
        kickoffMessage,
        referenceImages,
        source: 'skill',
        promptSource: {
          use_case: useCaseId,
          system_prompt: {
            kind: 'skill',
            content_hash: resolvedHash,
            char_count: skill.body.length,
            skill: {
              source_id: row.skill_source_id,
              source_label: sourceLabel,
              name: skill.name,
              dir_path: skill.dir_path,
              content_hash: skill.content_hash,
              last_commit_sha: skill.last_commit_sha,
            },
          },
          kickoff_message: kickoffMessage.length > 0
            ? { kind: 'inline', char_count: kickoffMessage.length }
            : { kind: 'empty', char_count: 0 },
        },
      };
    }
    // Skill bound but missing/empty/inaccessible — fall through to inline.
  }

  const inline = row.system_prompt ?? '';
  return {
    systemPrompt: inline,
    kickoffMessage,
    referenceImages: [],
    source: inline.length > 0 ? 'inline' : 'empty',
    promptSource: {
      use_case: useCaseId,
      system_prompt: {
        kind: inline.length > 0 ? 'inline' : 'empty',
        content_hash: inline.length > 0 ? sha256(inline) : '',
        char_count: inline.length,
      },
      kickoff_message: kickoffMessage.length > 0
        ? { kind: 'inline', char_count: kickoffMessage.length }
        : { kind: 'empty', char_count: 0 },
    },
  };
}

/**
 * Look up the bound skill. Tries `dir_path` first (current agentskills.io
 * column, post-013) then falls back to `name` so legacy use-case rows
 * that still carry just the skill name (or a `<name>.md` shape) keep
 * resolving correctly during the transition window.
 */
async function lookupSkill(
  supabase: Supabase,
  sourceId: string,
  skillPath: string,
): Promise<SkillRow | null> {
  // Primary: exact dir_path match.
  const byPath = await supabase
    .from('ai_skills')
    .select('name, dir_path, body, content_hash, last_commit_sha, reference_image_bytes, reference_image_mime')
    .eq('source_id', sourceId)
    .eq('dir_path', skillPath)
    .maybeSingle();
  if (byPath?.data) return byPath.data as SkillRow;

  // Fallback: strip a trailing /index.md or .md suffix and try by basename
  // matched against `name` (per agentskills.io invariant
  // basename(dir_path) === name).
  const basename = stripLegacySuffix(skillPath).split('/').pop() ?? '';
  if (basename.length === 0) return null;
  const byName = await supabase
    .from('ai_skills')
    .select('name, dir_path, body, content_hash, last_commit_sha, reference_image_bytes, reference_image_mime')
    .eq('source_id', sourceId)
    .eq('name', basename)
    .maybeSingle();
  return (byName?.data as SkillRow | null) ?? null;
}

interface SkillRow {
  name: string;
  dir_path: string;
  body: string;
  content_hash: string;
  last_commit_sha: string;
  reference_image_bytes?: unknown;
  reference_image_mime?: unknown;
}

interface RecipeRow {
  id: string;
  file_path: string;
  title: string;
  instructions: string;
  parse_status: 'ok' | 'refused' | 'parse_error';
  content_hash: string;
  last_commit_sha: string;
}

/**
 * Look up the bound recipe by (source_id, file_path). Returns the raw
 * row so the caller can decide what to do with a non-'ok' parse_status
 * (display the failure in the UI vs. silently fall back).
 */
async function lookupRecipe(
  supabase: Supabase,
  sourceId: string,
  filePath: string,
): Promise<RecipeRow | null> {
  const res = await supabase
    .from('ai_recipes')
    .select('id, file_path, title, instructions, parse_status, content_hash, last_commit_sha')
    .eq('source_id', sourceId)
    .eq('file_path', filePath)
    .maybeSingle();
  if (!res || res.error || !res.data) return null;
  return res.data as RecipeRow;
}

function stripLegacySuffix(p: string): string {
  if (p.endsWith('/index.md')) return p.slice(0, -'/index.md'.length);
  if (p.endsWith('.md')) return p.slice(0, -'.md'.length);
  return p;
}

async function lookupSourceLabel(
  supabase: Supabase,
  sourceId: string,
): Promise<string | null> {
  try {
    const r = await supabase
      .from('ai_agent_sources')
      .select('label')
      .eq('id', sourceId)
      .maybeSingle();
    if (r?.data && typeof (r.data as { label?: unknown }).label === 'string') {
      return (r.data as { label: string }).label;
    }
  } catch {
    // best-effort
  }
  return null;
}

function emptyProvenance(useCaseId: string): PromptSource {
  return {
    use_case: useCaseId,
    system_prompt: { kind: 'empty', content_hash: '', char_count: 0 },
    kickoff_message: { kind: 'empty', char_count: 0 },
  };
}

/**
 * The bytea column round-trips through postgrest as either a hex string
 * (`\x<hex>`) or a base64 string depending on driver settings. Normalise
 * to base64 for the Gemini inline payload.
 */
function extractReferenceImages(
  rawBytes: unknown,
  rawMime: unknown,
): ReferenceImage[] {
  if (typeof rawMime !== 'string' || rawMime.length === 0) return [];
  if (rawBytes == null) return [];

  let base64: string | null = null;
  if (typeof rawBytes === 'string') {
    if (rawBytes.startsWith('\\x')) {
      // Hex-encoded bytea string from PostgREST.
      const hex = rawBytes.slice(2);
      if (/^[0-9a-fA-F]*$/.test(hex) && hex.length % 2 === 0) {
        base64 = Buffer.from(hex, 'hex').toString('base64');
      }
    } else if (/^[A-Za-z0-9+/=]+$/.test(rawBytes)) {
      // Already base64.
      base64 = rawBytes;
    }
  } else if (rawBytes instanceof Uint8Array) {
    base64 = Buffer.from(rawBytes).toString('base64');
  }

  if (!base64 || base64.length === 0) return [];
  return [{ mimeType: rawMime, base64 }];
}

/**
 * Build a fallback PromptSource for callers that bypass resolveUseCasePrompt
 * (e.g. daily-briefing's research-runner.ts which uses a hardcoded
 * RESEARCH_SYSTEM_PROMPT when the use-case lookup returns empty).
 * The worker handler calls this so the chat widget can still surface
 * "kind=fallback" rather than "no provenance recorded".
 */
export function fallbackPromptSource(
  useCaseId: string,
  fallbackPrompt: string,
  kickoffMessage: string,
): PromptSource {
  return {
    use_case: useCaseId,
    system_prompt: {
      kind: 'fallback',
      content_hash: fallbackPrompt.length > 0 ? sha256(fallbackPrompt) : '',
      char_count: fallbackPrompt.length,
    },
    kickoff_message: kickoffMessage.length > 0
      ? { kind: 'inline', char_count: kickoffMessage.length }
      : { kind: 'empty', char_count: 0 },
  };
}
