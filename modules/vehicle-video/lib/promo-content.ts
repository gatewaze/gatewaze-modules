// @ts-nocheck — cross-module ai resolver loaded at runtime.

/**
 * Promo CONTENT resolution. The prompt text + caption copy + title-card wording
 * for each theme are authored in git (danthebaker/agents skills, one per theme:
 * `vehicle-video-promo-<themeId>`), NOT hardcoded in TypeScript — so they can be
 * edited without a redeploy. The skill body carries a single ```json block:
 *   { "shots": { "<key>": "<Kling prompt with {CAR}/{PLATE}>" },
 *     "captions": { "<key>": "<caption>" },
 *     "title_card": { "headline": "...", "cta": "..." } }
 * lib/promo-themes.ts holds ONLY the orchestration (which shots, seed angle,
 * durations, edit timings, grade). This resolver merges the git content in; a
 * thin inlined fallback in promo-themes keeps the module working if git isn't
 * synced (authoritative source is always git).
 */

import { resolveSkillBody } from './recipes.js';

export interface PromoContent {
  shots: Record<string, string>;
  captions: Record<string, string>;
  titleCard: { headline: string; cta: string };
}

/** Extract the first JSON object from a skill body (```json fenced or bare). */
function parseContent(body: string): PromoContent | null {
  const fenced = body.match(/```json\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : (body.match(/\{[\s\S]*\}/)?.[0] ?? '');
  if (!raw.trim()) return null;
  try {
    const d = JSON.parse(raw);
    return {
      shots: d.shots ?? {},
      captions: d.captions ?? {},
      titleCard: d.title_card ?? d.titleCard ?? { headline: '', cta: '' },
    };
  } catch {
    return null;
  }
}

/** Resolve a theme's prompt/caption content from its git skill; null if unavailable. */
export async function resolvePromoContent(supabase: unknown, themeId: string): Promise<PromoContent | null> {
  const body = await resolveSkillBody(supabase, `vehicle-video-promo-${themeId}`);
  return body ? parseContent(body) : null;
}
