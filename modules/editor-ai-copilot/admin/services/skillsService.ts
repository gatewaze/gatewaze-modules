/**
 * Browser-side reads for the per-host AI Skills picker.
 *
 * The skill catalogue lives in the ai module's `ai_skills` table
 * (synced from git-backed sources). Both `ai_skills` and
 * `ai_agent_sources` expose an authenticated SELECT policy, so the
 * picker reads them directly via the supabase client — same pattern as
 * the picker already uses for the host row's `active_skill_ids`. No
 * dedicated HTTP endpoint needed.
 *
 * Schema note: the column is `dir_path` (the agentskills.io
 * directory-as-skill identifier), NOT `path`; there is no `applies_to`
 * column on the current `ai_skills` schema (ai module migration 024).
 */

import { supabase } from '@/lib/supabase';

export interface SkillListItem {
  id: string;
  source_id: string;
  dir_path: string;
  name: string;
  description: string | null;
  source_label: string;
}

export interface SkillFull {
  id: string;
  name: string;
  dir_path: string;
  description: string | null;
  body: string;
}

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string } };

interface SkillRowWithSource {
  id: string;
  source_id: string;
  dir_path: string;
  name: string;
  description: string | null;
  source: { label: string | null } | { label: string | null }[] | null;
}

function sourceLabel(source: SkillRowWithSource['source']): string {
  const row = Array.isArray(source) ? source[0] : source;
  return row?.label ?? 'unknown source';
}

export const SkillsService = {
  /**
   * List every cleanly-parsed skill, newest first. Filtering by host
   * kind is intentionally NOT applied — the current `ai_skills` schema
   * has no `applies_to` column, so all skills are offered for every
   * host and the operator picks the relevant ones.
   */
  async listSkills(): Promise<ServiceResult<SkillListItem[]>> {
    const { data, error } = await supabase
      .from('ai_skills')
      .select('id, source_id, dir_path, name, description, source:ai_agent_sources!source_id(label)')
      .eq('parse_status', 'ok')
      .order('name', { ascending: true });
    if (error) return { ok: false, error: { message: error.message } };
    const value = ((data as SkillRowWithSource[] | null) ?? []).map((r) => ({
      id: r.id,
      source_id: r.source_id,
      dir_path: r.dir_path,
      name: r.name,
      description: r.description,
      source_label: sourceLabel(r.source),
    }));
    return { ok: true, value };
  },

  async readSkill(id: string): Promise<ServiceResult<SkillFull>> {
    const { data, error } = await supabase
      .from('ai_skills')
      .select('id, name, dir_path, description, body')
      .eq('id', id)
      .maybeSingle();
    if (error) return { ok: false, error: { message: error.message } };
    if (!data) return { ok: false, error: { message: 'skill not found' } };
    return { ok: true, value: data as SkillFull };
  },

  /**
   * Resolve a use case's bound default skill (its `skill_source_id` +
   * `skill_path`) to a display row, so the picker can show what an
   * "inherit" host will actually receive. Matches `dir_path` first then
   * `name` (mirrors the runtime resolver). Returns null when the use
   * case has no skill bound or the row is missing.
   */
  async readUseCaseDefaultSkill(useCaseId: string): Promise<ServiceResult<SkillListItem | null>> {
    const uc = await supabase
      .from('ai_use_cases')
      .select('skill_source_id, skill_path')
      .eq('id', useCaseId)
      .maybeSingle();
    if (uc.error) return { ok: false, error: { message: uc.error.message } };
    const ref = uc.data as { skill_source_id: string | null; skill_path: string | null } | null;
    if (!ref?.skill_source_id || !ref.skill_path) return { ok: true, value: null };

    const cols = 'id, source_id, dir_path, name, description, source:ai_agent_sources!source_id(label)';
    const byPath = await supabase
      .from('ai_skills')
      .select(cols)
      .eq('parse_status', 'ok')
      .eq('source_id', ref.skill_source_id)
      .eq('dir_path', ref.skill_path)
      .maybeSingle();
    let row = byPath.data as SkillRowWithSource | null;
    if (!row) {
      const basename = ref.skill_path.replace(/\/index\.md$/, '').replace(/\.md$/, '').split('/').pop() ?? '';
      if (basename.length > 0) {
        const byName = await supabase
          .from('ai_skills')
          .select(cols)
          .eq('parse_status', 'ok')
          .eq('source_id', ref.skill_source_id)
          .eq('name', basename)
          .maybeSingle();
        row = byName.data as SkillRowWithSource | null;
      }
    }
    if (!row) return { ok: true, value: null };
    return {
      ok: true,
      value: {
        id: row.id,
        source_id: row.source_id,
        dir_path: row.dir_path,
        name: row.name,
        description: row.description,
        source_label: sourceLabel(row.source),
      },
    };
  },
};
