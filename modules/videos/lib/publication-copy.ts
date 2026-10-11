// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * The title and description one video gets on one channel.
 *
 * Two routes to the same answer:
 *
 *   1. the `video-publication-copy` recipe in lf-agents, which writes a hook
 *   2. the deterministic template in lib/titles.ts, when the ai module is
 *      absent, the use case is unbound, or the run fails
 *
 * The template is deliberately the duller of the two. It cannot invent a
 * hook, which is the entire reason the recipe exists. What it can do is be
 * predictable, and an editor correcting a predictable title is better off
 * than one correcting something that changes on every run.
 *
 * Copy belongs to the PUBLICATION, not the video. Measured across the 30 most
 * recent videos on the two AAIF channels on 2026-10-11:
 *
 *   @AgenticAI-Foundation  no hashtags 15/15, no @mentions 15/15, long
 *                          four-part descriptions
 *   @AAIFLive              hashtags in the title 6/15, @mentions 10/15,
 *                          descriptions of 50 to 200 characters
 *
 * The same recording on both channels needs two different sets of words, so
 * the unit that owns them is one video plus one channel.
 */

import { generateCopy, type TitleInput } from './titles.js';

export const COPY_USE_CASE = 'video-publication-copy';

export type CopySource = 'recipe' | 'template' | 'human';

export interface PublicationCopy {
  title: string;
  description: string;
  hashtags: string[];
  source: CopySource;
  /** Why the recipe was not used, when it was not. Empty when it was. */
  fallbackReason: string;
}

export interface CopyContext extends TitleInput {
  /** 'foundation' | 'live' | 'shorts' — which house style applies. */
  profile?: string | null;
  platform?: string | null;
}

/**
 * Which editorial profile a publication follows.
 *
 * Resolved from the account, not the platform, because AAIF runs two YouTube
 * channels whose published copy differs measurably. Falls back to the
 * platform default, and then to 'foundation'.
 */
export async function resolveProfile(
  supabase,
  platform: string,
  externalId?: string | null,
): Promise<string> {
  if (externalId) {
    const { data } = await supabase
      .from('video_channel_profiles')
      .select('profile')
      .eq('platform', platform)
      .eq('external_id', externalId)
      .maybeSingle();
    if (data?.profile) return String(data.profile);
  }
  const { data: def } = await supabase
    .from('video_channel_profiles')
    .select('profile')
    .eq('platform', platform)
    .eq('is_default', true)
    .maybeSingle();
  return String(def?.profile ?? 'foundation');
}

/**
 * The template answer. Always available, never fails.
 *
 * Returns no hashtags for the 'foundation' profile because that channel uses
 * none on any of its 15 most recent videos, and a template has no basis for
 * choosing topical tags anyway — that is a judgement the recipe makes.
 */
export function templateCopy(ctx: CopyContext, reason: string): PublicationCopy {
  const platform = String(ctx.platform ?? 'youtube');
  const copy = generateCopy(ctx, [platform]);
  return {
    title: copy.titlesByPlatform[platform] ?? copy.title,
    description: copy.description,
    hashtags: [],
    source: 'template',
    fallbackReason: reason,
  };
}

/**
 * Ask the recipe, and fall back rather than fail.
 *
 * Returns the template answer for every unhappy path, with the reason
 * recorded, so an editor always has something to edit and an operator can see
 * why the better route was not taken.
 */
export async function generatePublicationCopy(
  supabase,
  ctx: CopyContext,
  opts: { dispatch?: (params: Record<string, string>) => Promise<{ ok: boolean; runId?: string; reason?: string }>; log?: (m: string) => void } = {},
): Promise<PublicationCopy & { runId?: string }> {
  const log = opts.log ?? (() => {});

  if (!opts.dispatch) return templateCopy(ctx, 'no_dispatcher');

  // Is the use case bound to a recipe at all? An install without the ai
  // module reaches here and must degrade quietly, not throw.
  const { data: uc } = await supabase
    .from('ai_use_cases')
    .select('id, recipe_source_id, recipe_file_path')
    .eq('id', COPY_USE_CASE)
    .maybeSingle();
  if (!uc?.recipe_source_id || !uc.recipe_file_path) {
    log('video-publication-copy use case is unbound — using the template');
    return templateCopy(ctx, 'use_case_unbound');
  }

  const params: Record<string, string> = {
    talk: JSON.stringify({
      title: ctx.talkTitle ?? '',
      takeaway: ctx.worthNoting ?? '',
      quote: ctx.quote ?? '',
    }),
    speakers: JSON.stringify(ctx.speakers ?? []),
    event: JSON.stringify({ title: ctx.eventName ?? '' }),
    channel_profile: String(ctx.profile ?? 'foundation'),
    video_kind: String(ctx.kind ?? 'master'),
    platforms: JSON.stringify([String(ctx.platform ?? 'youtube')]),
  };

  const res = await opts.dispatch(params).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
  if (!res.ok) {
    log(`copy recipe dispatch failed (${res.reason}) — using the template`);
    return templateCopy(ctx, res.reason ?? 'dispatch_failed');
  }

  // The run is asynchronous. The caller stores the template answer now and
  // the worker overwrites it when the run lands, which is why this returns
  // the template rather than waiting: an editor should never sit on a
  // spinner for a model call.
  return { ...templateCopy(ctx, 'awaiting_recipe'), runId: res.runId };
}

/**
 * Fold a finished recipe result onto a publication, preserving edits.
 *
 * `copy_edited_fields` names what a human has changed since generation. Those
 * fields are left alone, which is the same posture the schedule importer
 * takes: a machine never overwrites a person's work.
 */
export function applyRecipeResult(
  current: { title?: string | null; description?: string | null; hashtags?: string[] | null; copy_edited_fields?: string[] | null },
  result: { title?: string; description?: string; hashtags?: string[] },
): Record<string, unknown> {
  const edited = new Set(current.copy_edited_fields ?? []);
  const patch: Record<string, unknown> = {
    copy_source: 'recipe',
    copy_generated_at: new Date().toISOString(),
  };
  if (!edited.has('title') && result.title) patch.title = result.title;
  if (!edited.has('description') && result.description) patch.description = result.description;
  if (!edited.has('hashtags') && Array.isArray(result.hashtags)) patch.hashtags = result.hashtags;
  return patch;
}

/**
 * Render a chapter list as the Timestamps block.
 *
 * YouTube only draws a chapter bar when the first chapter is at 0:00, there
 * are at least three, and each is at least ten seconds. An almost-valid list
 * renders as plain text and silently does nothing, so this returns an empty
 * string rather than a block that will not work.
 */
export function renderChapters(chapters: Array<{ seconds: number; label: string }> | null | undefined): string {
  const list = (chapters ?? [])
    .filter((c) => Number.isFinite(Number(c?.seconds)) && typeof c?.label === 'string' && c.label.trim())
    .map((c) => ({ seconds: Math.floor(Number(c.seconds)), label: c.label.trim() }))
    .sort((a, b) => a.seconds - b.seconds);

  if (list.length < 3) return '';
  if (list[0].seconds !== 0) return '';
  for (let i = 1; i < list.length; i += 1) {
    if (list[i].seconds - list[i - 1].seconds < 10) return '';
  }

  const stamp = (s: number): string => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  };

  return ['Timestamps:', ...list.map((c) => `[${stamp(c.seconds)}] ${c.label}`)].join('\n');
}
