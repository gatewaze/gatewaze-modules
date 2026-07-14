/**
 * Buzzword-leaderboard worker — turns newsletter replies into a live
 * leaderboard of the AI phrases people say they hear most.
 *
 * Runs on a cron tick and does three things, in order:
 *   1. APPLY  — for replies dispatched on a previous tick, read their now-
 *               finished recipe run and stamp each reply with its extraction
 *               (or un-pend it if the run failed, so it retries).
 *   2. RENDER — tally every applied reply (pure, once-per-canonical-per-reply)
 *               and write the leaderboard HTML into the resource section.
 *   3. DISPATCH — if nothing is in-flight, prepare the next un-processed batch
 *               and dispatch ONE run, seeded with the current leaderboard as
 *               `known_phrases`. One batch per tick keeps canonicals
 *               consistent (each tick's dispatch sees the prior tick's tally)
 *               and bounds cost.
 *
 * Idempotency: every reply carries a `metadata.buzzwords` stamp once seen, so
 * it is never dispatched or counted twice. No migration — the marker lives in
 * the existing jsonb column.
 *
 * Config (installed_modules.config.buzzword):
 *   { enabled, newsletter_collection_id, resource_item_id?, edition_ids?,
 *     batch_size?, max_body_chars?, question_context? }
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Job } from 'bullmq';

import { dispatchBuzzwordRun } from '../lib/buzzword/dispatch.js';
import { DEFAULT_BATCH_SIZE, DEFAULT_MAX_BODY_CHARS, prepareReply, toBatches } from '../lib/buzzword/prepare.js';
import { ensureLeaderboardTarget, pinResourceItemId, writeLeaderboardHtml } from '../lib/buzzword/resource.js';
import { renderLeaderboardHtml } from '../lib/buzzword/render.js';
import { buildLeaderboard, extractionToStamp, knownPhrasesParam } from '../lib/buzzword/tally.js';
import type {
  ExtractionOutput,
  ReplyBuzzwordStamp,
  ReplyExtraction,
  ReplyRow,
} from '../lib/buzzword/types.js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const DEFAULT_QUESTION =
  'Reply with the buzz word or phrase you are hearing most often in AI right now.';

interface BuzzwordConfig {
  enabled?: boolean;
  newsletter_collection_id?: string;
  resource_item_id?: string | null;
  edition_ids?: string[];
  batch_size?: number;
  max_body_chars?: number;
  question_context?: string;
}

interface ReplyWithMeta extends ReplyRow {
  metadata: Record<string, unknown> | null;
}

function stampOf(row: ReplyWithMeta): ReplyBuzzwordStamp | null {
  const bz = (row.metadata ?? {})['buzzwords'];
  return bz && typeof bz === 'object' ? (bz as ReplyBuzzwordStamp) : null;
}

async function mergeStamp(
  supabase: SupabaseClient,
  row: ReplyWithMeta,
  stamp: ReplyBuzzwordStamp | null,
): Promise<void> {
  const meta = { ...(row.metadata ?? {}) };
  if (stamp === null) delete meta['buzzwords'];
  else meta['buzzwords'] = stamp;
  await supabase.from('newsletter_replies').update({ metadata: meta }).eq('id', row.id);
}

/** Load config from installed_modules.config.buzzword. */
async function loadConfig(supabase: SupabaseClient): Promise<BuzzwordConfig | null> {
  const res = await supabase
    .from('installed_modules')
    .select('config')
    .eq('id', 'newsletters')
    .maybeSingle();
  const cfg = (res.data as { config?: { buzzword?: BuzzwordConfig } } | null)?.config?.buzzword;
  return cfg ?? null;
}

/** Base filter: human replies to the configured collection (+ optional editions). */
function scopedReplyQuery(supabase: SupabaseClient, cfg: BuzzwordConfig) {
  let q = supabase
    .from('newsletter_replies')
    .select('id, from_name, subject, body_text, metadata')
    .eq('collection_id', cfg.newsletter_collection_id!)
    .eq('is_auto_reply', false);
  if (cfg.edition_ids && cfg.edition_ids.length > 0) {
    q = q.in('edition_id', cfg.edition_ids);
  }
  return q;
}

export default async function handleBuzzwordReplies(_job: Job<{ kind: string }>) {
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const cfg = await loadConfig(supabase);

  if (!cfg?.enabled || !cfg.newsletter_collection_id) {
    return { skipped: true, reason: cfg?.enabled ? 'no_collection' : 'disabled' };
  }

  const batchSize = cfg.batch_size ?? DEFAULT_BATCH_SIZE;
  const maxBody = cfg.max_body_chars ?? DEFAULT_MAX_BODY_CHARS;

  // ── 1. APPLY finished runs ────────────────────────────────────────────
  const pendRes = await scopedReplyQuery(supabase, cfg).eq('metadata->buzzwords->>status', 'pending');
  const pending = (pendRes.data as ReplyWithMeta[] | null) ?? [];

  let applied = 0;
  let inFlight = 0;
  const runIds = [...new Set(pending.map((r) => stampOf(r)?.run_id).filter(Boolean) as string[])];

  for (const runId of runIds) {
    const runRes = await supabase
      .from('ai_recipe_runs')
      .select('status, final_output')
      .eq('id', runId)
      .maybeSingle();
    const run = runRes.data as { status: string; final_output: ExtractionOutput | null } | null;
    const rowsForRun = pending.filter((r) => stampOf(r)?.run_id === runId);

    if (!run || run.status === 'running' || run.status === 'queued' || run.status === 'cancelling') {
      inFlight += rowsForRun.length;
      continue;
    }

    if (run.status === 'complete' && run.final_output?.extractions) {
      const byId = new Map<string, ReplyExtraction>();
      for (const e of run.final_output.extractions) byId.set(e.reply_id, e);
      const now = new Date().toISOString();
      for (const row of rowsForRun) {
        const ex = byId.get(row.id);
        if (!ex) {
          // Reply wasn't in the run's output — un-pend so it retries.
          await mergeStamp(supabase, row, null);
          continue;
        }
        await mergeStamp(supabase, row, extractionToStamp(ex, runId, now));
        applied += 1;
      }
    } else {
      // failed / cancelled / budget_blocked → un-pend so they retry next tick.
      for (const row of rowsForRun) await mergeStamp(supabase, row, null);
    }
  }

  // ── 2. RENDER from every applied reply ────────────────────────────────
  const appliedRes = await scopedReplyQuery(supabase, cfg).not('metadata->buzzwords->>applied_at', 'is', null);
  const appliedRows = (appliedRes.data as ReplyWithMeta[] | null) ?? [];
  const stamps = appliedRows.map(stampOf).filter(Boolean) as ReplyBuzzwordStamp[];
  const board = buildLeaderboard(stamps);
  const submissions = stamps.filter((s) => s.status === 'extracted').length;

  const target = await ensureLeaderboardTarget(supabase, cfg.resource_item_id);
  if (target) {
    // Pin a first-time auto-provisioned item so a later rename (which changes
    // its slug) can't make the next tick re-create a duplicate collection.
    if (target.autoProvisioned) await pinResourceItemId(supabase, target.itemId);
    const html = renderLeaderboardHtml(board, {
      submissions,
      distinct: board.length,
      updatedAt: new Date().toISOString(),
    });
    await writeLeaderboardHtml(supabase, target, html);
  }

  // ── 3. DISPATCH one new batch (only when nothing is in-flight) ─────────
  let dispatched = 0;
  let dispatchReason = 'in_flight';
  if (inFlight === 0) {
    const freshRes = await scopedReplyQuery(supabase, cfg)
      .is('metadata->buzzwords', null)
      .order('created_at', { ascending: true })
      .limit(batchSize);
    const fresh = (freshRes.data as ReplyWithMeta[] | null) ?? [];

    if (fresh.length === 0) {
      dispatchReason = 'nothing_to_process';
    } else {
      const [batch] = toBatches(fresh, batchSize);
      const prepared = batch.map((r) => prepareReply(r, maxBody));
      const result = await dispatchBuzzwordRun(supabase, {
        replies: JSON.stringify(prepared),
        known_phrases: JSON.stringify(knownPhrasesParam(board)),
        question_context: cfg.question_context ?? DEFAULT_QUESTION,
        edition_label: `${prepared.length} replies`,
      });
      if (result.ok && result.runId) {
        const now = new Date().toISOString();
        for (const row of batch) {
          await mergeStamp(supabase, row, { status: 'pending', run_id: result.runId });
        }
        dispatched = batch.length;
        dispatchReason = 'dispatched';
        void now;
      } else {
        dispatchReason = `dispatch_failed:${result.reason ?? 'unknown'}`;
      }
    }
  }

  const summary = {
    applied,
    in_flight: inFlight,
    dispatched,
    dispatch: dispatchReason,
    leaderboard_rows: board.length,
    submissions,
  };
  console.log('[newsletters:buzzword-replies]', JSON.stringify(summary));
  return summary;
}
