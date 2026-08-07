// @ts-nocheck — supabase-js + sibling libs resolved at module-host install time.

/**
 * event-speakers:generate-promo-kit — build one confirmed speaker's promo kit.
 *
 * Two-phase state machine driven by the promo-kit-sweep cron (the runtime
 * invokes handlers without an enqueue helper and WORKER_CONCURRENCY defaults
 * to 1, so this job never blocks waiting on another queued job):
 *
 *   requested  → mint the umami tracking link, render + upload the three
 *                card images, dispatch the speaker-promo-posts recipe run,
 *                → generating. (If the ai module is absent, text is marked
 *                failed and the kit finalizes immediately.)
 *   generating → read the recipe run back; when it has settled (or after
 *                too many polls), store the text, assemble + upload the zip,
 *                → ready. Cards + link ship even when the text fails.
 *
 * Idempotent at every step: slugs are deterministic, storage uploads upsert,
 * and re-dispatch only happens when no run id is recorded.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceClient } from '../lib/promo/service-client.js';
import { loadPromoKitContext, dateShort } from '../lib/promo/context.js';
import { mintSpeakerTrackingLink } from '../lib/promo/tracking-link.js';
import {
  renderSpeakerCards,
  resolveAvatarDataUri,
  TEMPLATE_VERSION,
} from '../lib/promo/render-cards.js';
import { loadTemplateSource, templateLoader, resolveBrandVars } from '../lib/promo/template-source.js';
import { buildRecipeParams, dispatchPromoTextRun, readPromoTextRun } from '../lib/promo/promo-text.js';
import { buildPromoKitZip } from '../lib/promo/build-zip.js';

interface JobInput {
  data?: { kitId?: string };
}

const BUCKET = 'media';
const STORAGE_PREFIX = 'speaker-promo-kits';
/** Sweep ticks to wait for the text run before shipping without it
 *  (sweep cadence is 2 min → ~40 min ceiling). */
const MAX_TEXT_POLLS = 20;

function storagePathFor(eventUuid: string, talkId: string, file: string): string {
  return `${STORAGE_PREFIX}/${eventUuid}/${talkId}/${file}`;
}

export default async function generatePromoKit(job: JobInput, ctx?: { moduleDir?: string }): Promise<void> {
  const kitId = job?.data?.kitId;
  if (!kitId) throw new Error('generate-promo-kit missing kitId');
  const supabase = serviceClient();
  const log = (m: string) => console.log(`[event-speakers] promo-kit ${kitId}: ${m}`);

  const { data: kit } = await supabase.from('speaker_promo_kits').select('*').eq('id', kitId).maybeSingle();
  if (!kit) {
    log('kit row missing — nothing to do');
    return;
  }
  if (kit.status === 'ready') return;

  const fail = async (message: string) => {
    log(`failed: ${message}`);
    await supabase
      .from('speaker_promo_kits')
      .update({ status: 'failed', error: message.slice(0, 800), attempts: (kit.attempts ?? 0) + 1 })
      .eq('id', kitId);
  };

  let context;
  try {
    context = await loadPromoKitContext(supabase, kit.talk_id);
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
    return;
  }
  if (context.talk.status !== 'confirmed') {
    await fail(`talk status is '${context.talk.status}', not confirmed`);
    return;
  }

  try {
    if (kit.status === 'requested' || kit.status === 'failed') {
      await runBuildPhase(supabase, kit, context, ctx, log);
    } else if (kit.status === 'generating') {
      await runFinalizePhase(supabase, kit, context, log);
    }
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
  }
}

async function runBuildPhase(supabase, kit, context, ctx, log): Promise<void> {
  await supabase
    .from('speaker_promo_kits')
    .update({
      status: 'generating',
      attempts: (kit.attempts ?? 0) + 1,
      error: null,
      event_uuid: context.event.id,
      speaker_profile_id: context.speaker.profileId,
    })
    .eq('id', kit.id);

  // 1. Tracking link (idempotent mint).
  const link = await mintSpeakerTrackingLink(supabase, {
    speakerProfileId: context.speaker.profileId,
    speakerName: context.speaker.fullName,
    event: context.event,
  });
  log(`tracking link ${link.shortUrl}`);

  // 2. Cards: resolve the template source (per-event repo override →
  // module-configured repo → vendored) + the event's brand colorway
  // (per-event brand_key override → mapping rules), render, upload.
  const moduleDir = ctx?.moduleDir ?? join(dirname(fileURLToPath(import.meta.url)), '..');
  const templatesDir = join(moduleDir, 'templates');
  const { data: eventConfig } = await supabase
    .from('speaker_promo_event_config')
    .select('template_repo, brand_key')
    .eq('event_uuid', context.event.id)
    .maybeSingle();
  const source = await loadTemplateSource(templatesDir, eventConfig?.template_repo);
  const brand = resolveBrandVars(source, context.event, eventConfig?.brand_key);
  log(`templates: ${source.origin}${source.ref ? ` (${source.ref})` : ''}${Object.keys(brand).length ? ', branded' : ', default colorway'}`);
  const avatarDataUri = await resolveAvatarDataUri(supabase, context.speaker.avatarUrl);
  const rendered = await renderSpeakerCards(templateLoader(source, templatesDir), {
    speaker: {
      full_name: context.speaker.fullName,
      job_title: context.speaker.jobTitle,
      company: context.speaker.company,
      avatar_data_uri: avatarDataUri,
    },
    talk: { title: context.talk.title },
    event: {
      date_short: dateShort(context.event.event_start, context.event.event_timezone),
      city: (context.event.event_city || 'ONLINE').toUpperCase(),
    },
    brand,
  });
  const cards = [];
  for (const card of rendered) {
    const path = storagePathFor(context.event.id, context.talk.id, `card-${card.format}.png`);
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, card.png, { contentType: 'image/png', cacheControl: '3600', upsert: true });
    if (upErr) throw new Error(`card upload failed (${card.format}): ${upErr.message}`);
    cards.push({ format: card.format, storage_path: path, width: card.width, height: card.height });
  }
  log(`rendered ${cards.length} cards`);

  // 3. Promo text: dispatch the recipe run (graceful when ai is absent).
  const dispatch = await dispatchPromoTextRun(supabase, buildRecipeParams(context, link.shortUrl));
  const patch = {
    tracking_slug: link.slug,
    tracking_short_url: link.shortUrl,
    tracking_destination_url: link.destinationUrl,
    tracking_redirect_id: link.redirectId,
    cards,
    template_version: source.origin === 'git' ? `git:${source.ref}` : TEMPLATE_VERSION,
  };
  if (dispatch.ok) {
    log(`promo text run dispatched (${dispatch.runId})`);
    await supabase
      .from('speaker_promo_kits')
      .update({ ...patch, ai_run_id: dispatch.runId, promo_text_status: 'pending' })
      .eq('id', kit.id);
    // Finalization happens on a later sweep tick, once the run settles.
  } else {
    log(`promo text unavailable (${dispatch.reason}) — shipping without text`);
    await supabase
      .from('speaker_promo_kits')
      .update({ ...patch, promo_text_status: 'failed', promo_text_error: dispatch.reason ?? 'dispatch_failed' })
      .eq('id', kit.id);
    const fresh = await refetch(supabase, kit.id);
    await finalizeKit(supabase, fresh, context, log);
  }
}

async function runFinalizePhase(supabase, kit, context, log): Promise<void> {
  if (kit.promo_text_status === 'pending' && kit.ai_run_id) {
    const run = await readPromoTextRun(supabase, kit.ai_run_id);
    if (run.state === 'pending') {
      const polls = (kit.attempts ?? 0) + 1;
      if (polls <= MAX_TEXT_POLLS) {
        await supabase.from('speaker_promo_kits').update({ attempts: polls }).eq('id', kit.id);
        log(`text run still pending (poll ${polls}/${MAX_TEXT_POLLS})`);
        return;
      }
      log('text run timed out — shipping without text');
      await supabase
        .from('speaker_promo_kits')
        .update({ promo_text_status: 'failed', promo_text_error: 'text_run_timeout' })
        .eq('id', kit.id);
    } else if (run.state === 'complete') {
      await supabase
        .from('speaker_promo_kits')
        .update({ promo_text: run.promoText, promo_text_status: 'ready', promo_text_error: null })
        .eq('id', kit.id);
      log('promo text ready');
    } else {
      await supabase
        .from('speaker_promo_kits')
        .update({ promo_text_status: 'failed', promo_text_error: run.reason.slice(0, 400) })
        .eq('id', kit.id);
      log(`promo text failed: ${run.reason}`);
    }
  }
  const fresh = await refetch(supabase, kit.id);
  if (fresh.promo_text_status !== 'pending') {
    await finalizeKit(supabase, fresh, context, log);
  }
}

async function refetch(supabase, kitId) {
  const { data } = await supabase.from('speaker_promo_kits').select('*').eq('id', kitId).maybeSingle();
  if (!data) throw new Error('kit row disappeared during generation');
  return data;
}

async function finalizeKit(supabase, kit, context, log): Promise<void> {
  // Re-download the card PNGs to bundle (they were uploaded in the build phase).
  const cardsWithBytes = [];
  for (const card of kit.cards ?? []) {
    const { data } = await supabase.storage.from(BUCKET).download(card.storage_path);
    if (!data) throw new Error(`card missing from storage: ${card.storage_path}`);
    cardsWithBytes.push({ ...card, png: Buffer.from(await data.arrayBuffer()) });
  }

  const zipBuffer = await buildPromoKitZip({
    speakerName: context.speaker.fullName,
    eventTitle: context.event.event_title,
    trackingUrl: kit.tracking_short_url,
    promoText: kit.promo_text_status === 'ready' ? kit.promo_text : null,
    cards: cardsWithBytes,
  });
  const zipPath = storagePathFor(context.event.id, context.talk.id, 'promo-kit.zip');
  const { error: zipErr } = await supabase.storage
    .from(BUCKET)
    .upload(zipPath, zipBuffer, { contentType: 'application/zip', cacheControl: '3600', upsert: true });
  if (zipErr) throw new Error(`zip upload failed: ${zipErr.message}`);

  await supabase
    .from('speaker_promo_kits')
    .update({
      status: 'ready',
      error: null,
      zip_storage_path: zipPath,
      generated_at: new Date().toISOString(),
    })
    .eq('id', kit.id);
  log('kit ready');
}
