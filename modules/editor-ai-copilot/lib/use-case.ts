/**
 * Editor copilot use-case ids.
 *
 * The single `editor-ai-copilot` use case was split per host kind so
 * newsletters and sites can carry their own model defaults, cost caps,
 * and — most importantly — their own DEFAULT brand skill (bound via
 * `ai_use_cases.skill_source_id` / `skill_path`). See ai module
 * migration 039.
 *
 * This id is the billing/threads/quota tag passed to the ai module's
 * runChat and the key the editor uses for transcript + per-tool quota
 * lookups, so it must stay in lockstep with the seeded `ai_use_cases`
 * rows.
 */

import type { HostKind } from './types.js';

export const NEWSLETTER_EDITOR_USE_CASE = 'newsletter-editor';
export const SITE_EDITOR_USE_CASE = 'site-editor';

export function editorUseCaseFor(hostKind: HostKind): string {
  return hostKind === 'newsletter' ? NEWSLETTER_EDITOR_USE_CASE : SITE_EDITOR_USE_CASE;
}
