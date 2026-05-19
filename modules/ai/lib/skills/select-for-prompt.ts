/**
 * Budget enforcer + ordering helper for active skills.
 *
 * Per spec-ai-skills.md §7.3:
 *   - Walk skills in priority order (input array order).
 *   - Include each full body while running total < cap.
 *   - The first skill that would exceed the cap is truncated to fit.
 *   - All later skills are dropped.
 *   - Caller gets back both the included (possibly truncated) skills
 *     and a separate list of dropped ones, plus a per-skill truncation
 *     record for the audit log.
 */

import type { SkillRow } from './skills-repo.js';

export interface SelectedSkill {
  id: string;
  name: string;
  body: string; // may be truncated
  original_chars: number;
  content_hash: string;
  status: 'full' | 'truncated';
}

export interface DroppedSkill {
  id: string;
  name: string;
  original_chars: number;
  content_hash: string;
  status: 'dropped';
}

export interface SkillSelectionResult {
  included: SelectedSkill[];
  dropped: DroppedSkill[];
  totalIncludedChars: number;
  /**
   * Per-skill record suitable for the audit row's
   * `active_skill_truncations` column. Includes ONLY skills that were
   * truncated or dropped (full-included skills are recorded via the
   * top-level `active_skill_ids` array).
   */
  audit: Array<{
    id: string;
    included_chars: number;
    original_chars: number;
    status: 'truncated' | 'dropped';
  }>;
}

const TRUNCATION_MARKER = '\n\n[skill truncated to fit prompt budget]';

export function selectActiveSkillsForPrompt(
  skills: SkillRow[],
  maxTotalChars: number,
): SkillSelectionResult {
  const included: SelectedSkill[] = [];
  const dropped: DroppedSkill[] = [];
  const audit: SkillSelectionResult['audit'] = [];

  let used = 0;
  let exhausted = false;

  for (const s of skills) {
    if (exhausted) {
      dropped.push({
        id: s.id,
        name: s.name,
        original_chars: s.body_chars,
        content_hash: s.content_hash,
        status: 'dropped',
      });
      audit.push({
        id: s.id,
        included_chars: 0,
        original_chars: s.body_chars,
        status: 'dropped',
      });
      continue;
    }

    const remaining = maxTotalChars - used;
    if (s.body_chars <= remaining) {
      // Full include.
      included.push({
        id: s.id,
        name: s.name,
        body: s.body,
        original_chars: s.body_chars,
        content_hash: s.content_hash,
        status: 'full',
      });
      used += s.body_chars;
    } else if (remaining > TRUNCATION_MARKER.length + 200) {
      // Truncate to fit. Leave room for the marker and a sensible
      // minimum content slice.
      const sliceLen = remaining - TRUNCATION_MARKER.length;
      const truncated = s.body.slice(0, sliceLen) + TRUNCATION_MARKER;
      included.push({
        id: s.id,
        name: s.name,
        body: truncated,
        original_chars: s.body_chars,
        content_hash: s.content_hash,
        status: 'truncated',
      });
      audit.push({
        id: s.id,
        included_chars: truncated.length,
        original_chars: s.body_chars,
        status: 'truncated',
      });
      used += truncated.length;
      exhausted = true;
    } else {
      // Not enough room even for a meaningful slice — drop.
      dropped.push({
        id: s.id,
        name: s.name,
        original_chars: s.body_chars,
        content_hash: s.content_hash,
        status: 'dropped',
      });
      audit.push({
        id: s.id,
        included_chars: 0,
        original_chars: s.body_chars,
        status: 'dropped',
      });
      exhausted = true;
    }
  }

  return { included, dropped, totalIncludedChars: used, audit };
}
