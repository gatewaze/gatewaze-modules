/**
 * Local skill-row read helper for editor-ai-copilot's generate flow.
 *
 * Phase-2 refactor: the full skills-repo lives in
 * `@gatewaze-modules/ai/lib/skills/skills-repo.ts`. Editor's `generate.ts`
 * only needs the `SkillRow` type and `readSkillsByIds` (used to fetch
 * the active skills for a host before piping them through
 * `select-for-prompt`). Rather than declare a peer dep on the ai module
 * just for those two symbols, we keep this minimal shim local —
 * single-purpose, no business logic, easy to delete if a future cleanup
 * moves the generate flow itself.
 *
 * Stays in sync with the ai module by copying the column list and
 * row shape verbatim. The ai_skills table is owned by the ai module's
 * 009 migration; this file just reads from it.
 */

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

export interface SkillRow {
  id: string;
  source_id: string;
  /**
   * Full path of the skill DIRECTORY within its source repo. This is the
   * agentskills.io directory-as-skill identifier; `basename(dir_path)`
   * equals `name`. (The column was renamed from the pre-013 `path` when
   * `ai_skills` was made agentskills.io-conformant — see ai module
   * migrations 013 + 024. There is no `tags`/`applies_to` column.)
   */
  dir_path: string;
  name: string;
  description: string | null;
  body: string;
  body_chars: number;
  content_hash: string;
  last_commit_sha: string;
  updated_at: string;
}

const SKILL_COLS =
  'id, source_id, dir_path, name, description, body, body_chars, content_hash, last_commit_sha, updated_at';

export async function readSkillsByIds(supabase: SupabaseLike, ids: string[]): Promise<SkillRow[]> {
  if (ids.length === 0) return [];
  const res = await supabase
    .from('ai_skills')
    .select(SKILL_COLS)
    .eq('parse_status', 'ok')
    .in('id', ids);
  const rows = (res?.data as SkillRow[] | null) ?? [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is SkillRow => r != null);
}

/**
 * Resolve a single skill bound to a use case via its (source_id, skill_path)
 * soft reference — the same lineage `ai_use_cases.skill_source_id` /
 * `skill_path` carry. Mirrors the ai module's `resolveUseCasePrompt`
 * lookup: match `dir_path` exactly first, then fall back to `name`
 * (the agentskills.io basename invariant guarantees uniqueness within a
 * source) so legacy `<name>.md` / bare-`<name>` bindings keep resolving.
 *
 * Returns null when the binding is unset, the row is missing, or it
 * didn't parse cleanly — callers treat that as "no default skill".
 */
export async function readSkillByRef(
  supabase: SupabaseLike,
  sourceId: string,
  skillPath: string,
): Promise<SkillRow | null> {
  const byPath = await supabase
    .from('ai_skills')
    .select(SKILL_COLS)
    .eq('parse_status', 'ok')
    .eq('source_id', sourceId)
    .eq('dir_path', skillPath)
    .maybeSingle();
  if (byPath?.data) return byPath.data as SkillRow;

  const basename = stripLegacySuffix(skillPath).split('/').pop() ?? '';
  if (basename.length === 0) return null;
  const byName = await supabase
    .from('ai_skills')
    .select(SKILL_COLS)
    .eq('parse_status', 'ok')
    .eq('source_id', sourceId)
    .eq('name', basename)
    .maybeSingle();
  return (byName?.data as SkillRow | null) ?? null;
}

function stripLegacySuffix(p: string): string {
  if (p.endsWith('/index.md')) return p.slice(0, -'/index.md'.length);
  if (p.endsWith('.md')) return p.slice(0, -'.md'.length);
  return p;
}
