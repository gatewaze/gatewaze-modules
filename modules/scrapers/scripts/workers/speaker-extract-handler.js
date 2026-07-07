/**
 * BullMQ handler: scraper:speaker-extract.
 *
 * Replaces the previous inline-per-event speaker extraction in
 * scraper-job-handler.js. Now the scrape job collects event UUIDs and
 * enqueues ONE bulk job for the whole run; this handler processes them
 * sequentially with budget enforcement via callAnthropic.
 *
 * Why bulk-of-events instead of one-job-per-event:
 *   - the user-facing scrape job completes immediately after the events
 *     are saved, instead of waiting for ~3-6 s of Anthropic latency per
 *     event (the original perceived "slow" of the Fast scraper variants);
 *   - Anthropic rate limits / per-brand budgets are enforced once at the
 *     job boundary instead of N times racing against each other;
 *   - on BudgetExceededError we re-enqueue the unfinished tail with a
 *     delay matching the budget reset window — no events are silently
 *     dropped.
 *
 * Payload (validated lightly — passthrough JSON in BullMQ):
 *   {
 *     event_uuids: string[],   // gatewaze events.id values
 *     scraper_id?: number,     // for context.scraper_id in the ledger
 *     brand_id?: string,       // for the per-brand cost ledger
 *   }
 */

import { createHash } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';

import {
  extractHostsFromLumaData,
  extractSpeakersFromHtml,
  upsertSpeakers,
} from '../lib/luma-extractor.js';


/**
 * "Past event" cutoff — we treat events whose end-time is older than this
 * margin as immutable and skip re-extraction once speakers_extracted_at
 * is set. Margin gives some slop for timezone-confused cron schedules
 * and last-minute description tweaks during the actual event.
 */
const PAST_EVENT_GRACE_HOURS = 6;


function isPastImmutable(eventEnd) {
  if (!eventEnd) return false;
  const endMs = Date.parse(eventEnd);
  if (Number.isNaN(endMs)) return false;
  return endMs < Date.now() - PAST_EVENT_GRACE_HOURS * 3600 * 1000;
}


function contentHash(html) {
  return createHash('sha256').update(html).digest('hex');
}


const HANDLER_NAME = '[scraper:speaker-extract]';

let _supabase = null;
function supabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(`${HANDLER_NAME} missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY`);
  }
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}


/**
 * Process the speaker-extraction work for a single event row.
 * Returns the per-event outcome so the handler can sum stats.
 *
 * Throws BudgetExceededError up to the caller — the bulk handler treats
 * that specifically (re-queue tail + give up on this run).
 */
async function processOneEvent({ sb, eventRow, brandId, scraperId, log }) {
  const eventTitle = eventRow.event_title || '(unknown)';
  const alreadyExtracted = eventRow.speakers_extracted_at != null;

  // ── Skip 1: past events that have already been extracted ────────────
  // Once an event has ended, its description is locked. Re-extracting on
  // every daily scrape wastes Anthropic spend with zero new information.
  // The PAST_EVENT_GRACE_HOURS margin handles last-minute description
  // edits during/just-after the live event.
  if (alreadyExtracted && isPastImmutable(eventRow.event_end)) {
    return { status: 'skipped_past_event' };
  }

  // Pick the description source the same way the old inline code did:
  // prefer the rich processed HTML, fall back to free-form description.
  const html =
    eventRow.luma_processed_html ||
    eventRow.page_content ||
    eventRow.event_description ||
    '';

  // ── Skip 2: no content ──────────────────────────────────────────────
  if (!html || html.trim().length < 50) {
    // Mark as processed so we don't re-attempt next run; no hash because
    // we never actually ran extraction on a real input.
    await sb
      .from('events')
      .update({ speakers_extracted_at: new Date().toISOString() })
      .eq('id', eventRow.id);
    return { status: 'skipped_no_content' };
  }

  const newHash = contentHash(html);

  // ── Skip 3: content unchanged since last extraction ─────────────────
  // Daily re-scrape steady-state: ~90 % of events have the same hash as
  // last time. The Anthropic call is the dominant per-event cost, so this
  // is the biggest single savings lever in the whole pipeline.
  if (
    alreadyExtracted &&
    eventRow.speakers_extracted_content_hash &&
    eventRow.speakers_extracted_content_hash === newHash
  ) {
    return { status: 'skipped_unchanged' };
  }

  // ── Run extraction ───────────────────────────────────────────────────
  const speakers = await extractSpeakersFromHtml(html, eventTitle, {
    supabase: sb,
    brandId,
    eventId: eventRow.id,
    scraperId,
  });

  let upsertResult = null;
  if (speakers.length > 0) {
    const eventContext = {
      sourceEventId: eventRow.luma_event_id || eventRow.source_event_id || eventRow.event_id,
      gatewazeEventId: eventRow.id,
      eventTitle,
      eventUrl: eventRow.event_link,
      eventStartAt: eventRow.event_start,
      // calendarName isn't stored on the event row directly; the inline
      // version had it from cleanedEvent.account at scrape time. We
      // accept null here — the speaker upserter only uses it for logging.
      calendarName: null,
      guestCount: eventRow.luma_guest_count ?? null,
    };
    upsertResult = await upsertSpeakers(sb, speakers, eventContext);
  }

  // Mark processed AND record the input hash so future runs can short-
  // circuit when content is unchanged.
  await sb
    .from('events')
    .update({
      speakers_extracted_at: new Date().toISOString(),
      speakers_extracted_content_hash: newHash,
    })
    .eq('id', eventRow.id);

  if (upsertResult?.skipped) {
    log(`${HANDLER_NAME} ${eventRow.id}: skipped (${upsertResult.skipped})`);
    return { status: 'skipped_module_disabled' };
  }
  if (upsertResult && (upsertResult.inserted || upsertResult.linked)) {
    log(
      `${HANDLER_NAME} ${eventRow.id}: ${upsertResult.inserted ?? 0} new + ${upsertResult.linked ?? 0} linked`,
    );
    return { status: 'extracted', speakers: speakers.length };
  }
  return { status: 'no_speakers' };
}


export default async function handler(job) {
  const sb = supabase();
  const log = (msg) => {
    try { console.log(msg); } catch { /* swallow */ }
  };

  const data = job?.data ?? {};
  const eventUuids = Array.isArray(data.event_uuids) ? data.event_uuids : [];
  const scraperId = data.scraper_id ?? null;
  const brandId = data.brand_id || process.env.BRAND || 'default';

  if (eventUuids.length === 0) {
    log(`${HANDLER_NAME} empty event_uuids array, nothing to do`);
    return { processed: 0, skipped: 0, extracted: 0, no_speakers: 0 };
  }

  log(
    `${HANDLER_NAME} starting bulk for ${eventUuids.length} event(s) ` +
    `(brand=${brandId}, scraper=${scraperId ?? 'n/a'})`,
  );

  // Fetch the rows in one round-trip (covers small bulk; on 1000+ events
  // we'd page, but typical scrape jobs hit 50-200).
  const { data: rows, error: fetchErr } = await sb
    .from('events')
    .select(
      'id, event_id, event_title, event_link, event_description, luma_processed_html, page_content, luma_event_id, source_event_id, event_start, event_end, luma_guest_count, speakers_extracted_at, speakers_extracted_content_hash',
    )
    .in('id', eventUuids);
  if (fetchErr) {
    throw new Error(`${HANDLER_NAME} failed to load event rows: ${fetchErr.message}`);
  }

  // Sequential — Anthropic rate limit (and the per-brand budget) is the
  // bottleneck, not parallelism. Concurrent extraction would just race
  // each other to BudgetExceededError.
  //
  // Counter discipline: every event lands in exactly ONE bucket.
  // The per-bucket totals + savings logging make the cost-saving early-
  // skip behaviour visible to the operator on every run, which is the
  // whole point of moving the extraction async in the first place.
  let extracted = 0;
  let noSpeakers = 0;
  let skippedPastEvent = 0;
  let skippedUnchanged = 0;
  let skippedNoContent = 0;
  let skippedModuleDisabled = 0;
  let processed = 0;
  const failedTail = [];

  for (let i = 0; i < (rows ?? []).length; i++) {
    const row = rows[i];
    try {
      const result = await processOneEvent({
        sb, eventRow: row, brandId, scraperId, log,
      });
      processed++;
      switch (result.status) {
        case 'extracted':              extracted++; break;
        case 'no_speakers':            noSpeakers++; break;
        case 'skipped_past_event':     skippedPastEvent++; break;
        case 'skipped_unchanged':      skippedUnchanged++; break;
        case 'skipped_no_content':     skippedNoContent++; break;
        case 'skipped_module_disabled': skippedModuleDisabled++; break;
        default:                       /* unknown status; counted in processed */ break;
      }
    } catch (err) {
      // BudgetExceededError surfaces here. Stop the bulk and re-queue
      // the tail (events not yet processed) with a delay until the
      // budget window resets, so we don't hammer the API for nothing.
      if (err && err.name === 'BudgetExceededError') {
        const remaining = rows.slice(i).map((r) => r.id);
        const retryDelayMs = Math.max(
          60_000,
          (err.retry_after_seconds ?? 60) * 1000,
        );
        log(
          `${HANDLER_NAME} budget exceeded after ${processed} events; ` +
          `re-queueing tail of ${remaining.length} for ${Math.round(retryDelayMs / 1000)}s`,
        );

        // BullMQ exposes job.queue.add(...) on the running job's queue
        // instance. We re-add ourselves with the unfinished tail. If
        // the harness doesn't expose .queue (e.g. unit tests), we fall
        // back to recording the tail in failedTail and surfacing it.
        if (job?.queue?.add) {
          await job.queue.add(
            'scraper:speaker-extract',
            {
              event_uuids: remaining,
              scraper_id: scraperId,
              brand_id: brandId,
              _retry_reason: 'budget_exceeded',
            },
            { delay: retryDelayMs },
          );
        } else {
          failedTail.push(...remaining);
        }
        break;
      }
      // Per-event failure (unexpected) — log and continue. Don't fail
      // the whole bulk for one bad row.
      log(
        `${HANDLER_NAME} ${row.id}: extraction error (skipping, will retry on a later run): ${err.message}`,
      );
      noSpeakers++;
      processed++;
    }
  }

  // Anthropic-call savings — past + unchanged are the two categories
  // that would have fired a paid call before the skip checks landed.
  // Surface this on every run so the cost reduction is verifiable.
  const anthropicCallsAvoided = skippedPastEvent + skippedUnchanged;
  const anthropicCallsMade = extracted + noSpeakers;
  const totalRelevant = anthropicCallsAvoided + anthropicCallsMade;
  const savingsPct = totalRelevant > 0
    ? Math.round((anthropicCallsAvoided / totalRelevant) * 100)
    : 0;

  log(
    `${HANDLER_NAME} bulk complete: processed=${processed} ` +
    `extracted=${extracted} no_speakers=${noSpeakers} ` +
    `skipped_past=${skippedPastEvent} skipped_unchanged=${skippedUnchanged} ` +
    `skipped_no_content=${skippedNoContent} skipped_module_disabled=${skippedModuleDisabled} ` +
    `failed_tail=${failedTail.length}`,
  );
  if (anthropicCallsAvoided > 0) {
    log(
      `${HANDLER_NAME} 💰 Anthropic calls avoided: ${anthropicCallsAvoided}/${totalRelevant} (${savingsPct}% saved)`,
    );
  }

  // Suppress lint on the unused export — it's there for potential
  // future bulk-host-extract handler reuse.
  // eslint-disable-next-line no-unused-expressions
  void extractHostsFromLumaData;

  return {
    processed,
    extracted,
    no_speakers: noSpeakers,
    skipped_past_event: skippedPastEvent,
    skipped_unchanged: skippedUnchanged,
    skipped_no_content: skippedNoContent,
    skipped_module_disabled: skippedModuleDisabled,
    anthropic_calls_avoided: anthropicCallsAvoided,
    anthropic_calls_made: anthropicCallsMade,
    failed_tail: failedTail,
  };
}
