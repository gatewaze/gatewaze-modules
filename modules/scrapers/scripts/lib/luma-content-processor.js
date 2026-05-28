/**
 * Luma Content Processor
 *
 * Ported from gatewaze-admin/scripts/workers/luma-content-handler.js but
 * inlined as a sync helper rather than a separate BullMQ worker — so it
 * can be called directly from scraper-job-handler.js right after each
 * event create/update succeeds.
 *
 * Pipeline:
 *   1. Pull description_mirror (ProseMirror JSON) out of luma_page_data.
 *   2. Compute MD5; skip if unchanged + already processed.
 *   3. Convert ProseMirror → HTML.
 *   4. Download lumacdn.com images, re-upload to Supabase storage,
 *      rewrite img src in HTML to the new public URLs.
 *   5. Write luma_processed_html + luma_processed_at + luma_page_data_hash
 *      + luma_processing_status='completed' (or 'failed' / 'skipped').
 *
 * Returns the processed HTML so the caller can feed it into the speaker
 * extractor (extractSpeakersFromHtml).
 */

import crypto from 'crypto';
import { ProseMirrorConverter } from './prosemirror-converter.js';
import { processAllImages } from './event-content-image-service.js';

function computeHash(descriptionMirror) {
  if (!descriptionMirror) return null;
  return crypto.createHash('md5').update(JSON.stringify(descriptionMirror)).digest('hex');
}

function extractDescriptionMirror(lumaPageData) {
  if (!lumaPageData) return null;
  const candidates = [
    lumaPageData?.pageProps?.initialData?.data?.description_mirror,
    lumaPageData?.pageProps?.data?.description_mirror,
    lumaPageData?.data?.description_mirror,
  ];
  for (const c of candidates) if (c && typeof c === 'object') return c;
  return null;
}

/**
 * Process a single event's luma_page_data → luma_processed_html.
 *
 * @param {object} args
 * @param {object} args.supabase  Supabase service-role client
 * @param {string} args.eventUuid Event UUID (events.id)
 * @param {object} args.lumaPageData  The freshly-scraped lumaPageData (avoid
 *   refetching since the scraper already has it in memory). May be null/undef.
 * @param {object} [args.options]
 * @param {boolean} [args.options.processImages=true]
 * @param {boolean} [args.options.forceReprocess=false]
 * @param {function} [args.logger]
 * @returns {Promise<{success:boolean, html:string|null, hash:string|null, skipped:boolean, reason?:string, error?:string}>}
 */
export async function processLumaContentInline({
  supabase,
  eventUuid,
  lumaPageData,
  options = {},
  logger = console.log,
}) {
  const { processImages = true, forceReprocess = false } = options;

  if (!eventUuid) return { success: false, error: 'eventUuid required', html: null, hash: null, skipped: false };

  try {
    if (!lumaPageData) {
      // Fall back to fetching from DB if caller didn't pass it.
      const { data: row } = await supabase
        .from('events')
        .select('luma_page_data, luma_page_data_hash, luma_processing_status')
        .eq('id', eventUuid).single();
      lumaPageData = row?.luma_page_data ?? null;
      if (!lumaPageData) {
        return { success: true, html: null, hash: null, skipped: true, reason: 'no_luma_page_data' };
      }
    }

    const descriptionMirror = extractDescriptionMirror(lumaPageData);
    if (!descriptionMirror) {
      await supabase.from('events').update({
        luma_processing_status: 'skipped',
        luma_processing_error: 'no_description_mirror',
      }).eq('id', eventUuid);
      return { success: true, html: null, hash: null, skipped: true, reason: 'no_description_mirror' };
    }

    const newHash = computeHash(descriptionMirror);

    if (!forceReprocess) {
      const { data: existing } = await supabase
        .from('events')
        .select('luma_page_data_hash, luma_processing_status, luma_processed_html')
        .eq('id', eventUuid).single();
      if (existing?.luma_page_data_hash === newHash && existing?.luma_processing_status === 'completed') {
        return { success: true, html: existing.luma_processed_html, hash: newHash, skipped: true, reason: 'unchanged' };
      }
    }

    await supabase.from('events').update({ luma_processing_status: 'processing' }).eq('id', eventUuid);

    // ProseMirror → HTML
    const converter = new ProseMirrorConverter();
    let html = converter.convert(descriptionMirror);
    const images = converter.getImages();

    // Image migration (lumacdn → Supabase storage). On any failure the
    // original CDN URL is kept so the HTML still renders.
    let imageStats = { processed: 0, failed: 0 };
    if (processImages && images.length > 0) {
      const urlMap = await processAllImages(supabase, images, eventUuid);
      for (const [originalUrl, newUrl] of urlMap) {
        if (originalUrl !== newUrl) {
          html = ProseMirrorConverter.replaceImageUrl(html, originalUrl, newUrl);
          imageStats.processed++;
        } else {
          imageStats.failed++;
        }
      }
    }

    const { error: updErr } = await supabase.from('events').update({
      luma_processed_html: html,
      luma_page_data_hash: newHash,
      luma_processing_status: 'completed',
      luma_processed_at: new Date().toISOString(),
      luma_processing_error: null,
    }).eq('id', eventUuid);
    if (updErr) throw new Error(updErr.message);

    logger(`📝 Luma HTML processed: ${html.length} chars, ${imageStats.processed} images migrated, ${imageStats.failed} kept upstream`);
    return { success: true, html, hash: newHash, skipped: false };
  } catch (err) {
    try {
      await supabase.from('events').update({
        luma_processing_status: 'failed',
        luma_processing_error: String(err?.message ?? err).slice(0, 1000),
      }).eq('id', eventUuid);
    } catch {}
    return { success: false, html: null, hash: null, skipped: false, error: err.message ?? String(err) };
  }
}
