// @ts-nocheck — supabase-js resolved at module-host install time.

/**
 * Dispatch + read-back for the speaker-promo-posts recipe run.
 *
 * Same enqueue-and-poll shape as the newsletters buzzword dispatch (and for
 * the same reasons): the platform's worker dispatcher invokes handlers as
 * `handler(job)` without threading ctx.enqueueJob, and with WORKER_CONCURRENCY
 * defaulting to 1 an in-process await of another queued job would deadlock the
 * queue — so the promo-kit worker dispatches the run and picks the result up
 * on a later sweep tick.
 */

import { Queue } from 'bullmq';
import type { PromoKitContext, PromoText } from './types.js';

export const PROMO_TEXT_USE_CASE = 'speaker-promo-posts';

function bullPrefix(): string {
  return `bull:${process.env.BRAND ?? 'default'}`;
}

function jobsQueue(): Queue {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return new Queue('jobs', {
    prefix: bullPrefix(),
    connection: {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password ? decodeURIComponent(url.password) : undefined,
      username: url.username ? decodeURIComponent(url.username) : undefined,
    },
  });
}

/** Format a date as spoken copy, e.g. "August 6", in the event's timezone. */
export function dateLong(iso: string, timezone: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      timeZone: timezone || 'UTC',
    }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(iso));
  }
}

export function buildRecipeParams(ctx: PromoKitContext, registrationUrl: string): Record<string, string> {
  return {
    speaker: JSON.stringify({
      full_name: ctx.speaker.fullName,
      job_title: ctx.speaker.jobTitle ?? '',
      company: ctx.speaker.company ?? '',
      bio: (ctx.speaker.bio ?? '').slice(0, 2000),
    }),
    talk: JSON.stringify({
      title: ctx.talk.title,
      synopsis: (ctx.talk.synopsis ?? '').slice(0, 4000),
      session_type: ctx.talk.session_type ?? 'talk',
      duration_minutes: ctx.talk.duration_minutes ?? null,
    }),
    event: JSON.stringify({
      title: ctx.event.event_title,
      date_long: dateLong(ctx.event.event_start, ctx.event.event_timezone),
      city_or_format: ctx.event.event_city || 'online',
    }),
    registration_url: registrationUrl,
    other_speakers: JSON.stringify(ctx.otherSpeakers.slice(0, 12)),
  };
}

export interface DispatchResult {
  ok: boolean;
  runId?: string;
  reason?: string;
}

/** Insert an ai_recipe_runs row for the promo-posts use-case and enqueue it.
 *  Returns ok:false (not throw) when the ai module is absent/unbound so the
 *  kit ships without text. */
export async function dispatchPromoTextRun(supabase, params: Record<string, string>): Promise<DispatchResult> {
  const ucRes = await supabase
    .from('ai_use_cases')
    .select('id, recipe_source_id, recipe_file_path')
    .eq('id', PROMO_TEXT_USE_CASE)
    .maybeSingle();
  const uc = ucRes?.data;
  if (!uc?.recipe_source_id || !uc.recipe_file_path) return { ok: false, reason: 'use_case_unbound' };

  const rRes = await supabase
    .from('ai_recipes')
    .select(
      'id, version, title, description, instructions, prompt, parameters, response_schema, settings, sub_recipe_refs, extensions, content_hash, last_commit_sha, parse_status',
    )
    .eq('source_id', uc.recipe_source_id)
    .eq('file_path', uc.recipe_file_path)
    .maybeSingle();
  const rec = rRes?.data;
  if (!rec) return { ok: false, reason: 'recipe_missing' };
  if (rec.parse_status !== 'ok') return { ok: false, reason: `recipe_not_runnable:${rec.parse_status}` };

  const insRes = await supabase
    .from('ai_recipe_runs')
    .insert({
      recipe_id: rec.id,
      recipe_file_path: uc.recipe_file_path,
      recipe_content_hash: rec.content_hash,
      use_case: PROMO_TEXT_USE_CASE,
      params,
      status: 'queued',
      steps: [],
      recipe_snapshot: {
        version: rec.version,
        title: rec.title,
        description: rec.description,
        instructions: rec.instructions,
        prompt: rec.prompt,
        parameters: rec.parameters,
        response_schema: rec.response_schema,
        settings: rec.settings,
        sub_recipes: rec.sub_recipe_refs,
        extensions: rec.extensions,
        content_hash: rec.content_hash,
      },
      sub_recipes_snapshot: {},
      recipe_source: {
        kind: 'source-registered',
        recipe_id: rec.id,
        file_path: uc.recipe_file_path,
        content_hash: rec.content_hash,
        last_commit_sha: rec.last_commit_sha,
        sub_recipes: [],
      },
    })
    .select('id')
    .maybeSingle();
  const runId = insRes?.data?.id;
  if (!runId) return { ok: false, reason: `insert_failed:${insRes?.error?.message ?? 'no_row'}` };

  let queue: Queue | null = null;
  try {
    queue = jobsQueue();
    const job = await queue.add('ai:run-recipe', {
      runId,
      useCase: PROMO_TEXT_USE_CASE,
      enqueuedAt: new Date().toISOString(),
    });
    await supabase.from('ai_recipe_runs').update({ bull_job_id: job.id ?? null }).eq('id', runId);
    return { ok: true, runId };
  } catch (err) {
    await supabase
      .from('ai_recipe_runs')
      .update({ status: 'failed', failure_reason: 'enqueue_failed', completed_at: new Date().toISOString() })
      .eq('id', runId);
    return { ok: false, runId, reason: `enqueue_failed:${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (queue) await queue.close().catch(() => {});
  }
}

export type RunState =
  | { state: 'pending' }
  | { state: 'complete'; promoText: PromoText }
  | { state: 'failed'; reason: string };

/** Read a dispatched run back and validate its output shape. */
/**
 * House rule: we never publish em or en dashes. The model is told this in the
 * recipe, but a model instruction is a request, not a guarantee, so the text
 * is normalised on the way out of the run as well. " - " is the replacement,
 * matching the house writing style.
 *
 * Applied to the post bodies and the mention note, which is the other string
 * that reaches a speaker's screen.
 */
function stripDashes(text: string): string {
  return text
    .replace(/\s*[\u2014\u2013]\s*/g, ' - ')
    .replace(/[ \t]{2,}/g, ' ');
}

export async function readPromoTextRun(supabase, runId: string): Promise<RunState> {
  const { data: run } = await supabase
    .from('ai_recipe_runs')
    .select('status, final_output, failure_reason')
    .eq('id', runId)
    .maybeSingle();
  if (!run) return { state: 'failed', reason: 'run_row_missing' };
  if (run.status === 'queued' || run.status === 'running') return { state: 'pending' };
  if (run.status !== 'complete') {
    return { state: 'failed', reason: run.failure_reason || `run_${run.status}` };
  }
  // final_output can arrive as a string; defend like lunch-and-learn does.
  let out = run.final_output;
  if (typeof out === 'string') {
    try {
      out = JSON.parse(out);
    } catch {
      return { state: 'failed', reason: 'final_output_not_json' };
    }
  }
  const options = Array.isArray(out?.options) ? out.options : null;
  if (!options || options.length === 0) return { state: 'failed', reason: 'no_options_in_output' };
  const clean = options
    .filter((o) => o && typeof o.body === 'string' && o.body.trim().length > 0)
    .map((o) => ({
      key: String(o.key ?? 'professional'),
      label: String(o.label ?? o.key ?? 'Option'),
      body: stripDashes(String(o.body).trim()),
    }));
  if (clean.length === 0) return { state: 'failed', reason: 'no_valid_options' };
  const promoText: PromoText = { options: clean };
  if (typeof out.mention_note === 'string' && out.mention_note.trim()) {
    promoText.mention_note = stripDashes(out.mention_note.trim());
  }
  return { state: 'complete', promoText };
}
