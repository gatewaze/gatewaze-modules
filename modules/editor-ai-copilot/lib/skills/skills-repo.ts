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
  path: string;
  name: string;
  description: string | null;
  tags: string[];
  applies_to: string[];
  body: string;
  body_chars: number;
  content_hash: string;
  last_commit_sha: string;
  updated_at: string;
}

export async function readSkillsByIds(supabase: SupabaseLike, ids: string[]): Promise<SkillRow[]> {
  if (ids.length === 0) return [];
  const res = await supabase
    .from('ai_skills')
    .select('id, source_id, path, name, description, tags, applies_to, body, body_chars, content_hash, last_commit_sha, updated_at')
    .in('id', ids);
  const rows = (res?.data as SkillRow[] | null) ?? [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is SkillRow => r != null);
}
