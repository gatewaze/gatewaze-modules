// @ts-nocheck — supabase-js + sibling-module libs resolved at module-host install time.

/**
 * vehicle-video:scrape-and-script — Phase A (cheap; auto-runs on create).
 *
 *   1. Ingest   — resolve the Auto Trader listing (or use uploaded photos), pull
 *                 the whole gallery, normalise via sharp, store to media.
 *   2. Style    — resolve the market, infer the style profile (character+knobs).
 *   3. Script   — shortlist the gallery, curate shots to the shot plan (vision),
 *                 write shot rows. → script_status = ready_for_review.
 *
 * No Veo/TTS here. On error: script_status = failed + structured error (final attempt).
 */

import { serviceClient, envInt } from '../lib/service-client.js';
import { assertSafeUrl } from '../lib/ssrf-guard.js';
import { fetchCarDetails } from '../lib/autotrader.js';
import { normalise, shortlist } from '../lib/images.js';
import { inferStyle, curateShots, styleTemplateBody } from '../lib/recipes.js';
import { mergeOverrides, coerceCharacter, neutralDefaultProfile } from '../lib/style.js';
import { runPrefix } from '../lib/storage.js';
import { toStructuredError, VehicleVideoError } from '../lib/errors.js';

interface JobInput {
  data: { runId?: string };
  attemptsMade?: number;
  opts?: { attempts?: number };
}

const BUCKET = process.env.HOST_MEDIA_BUCKET ?? 'media';

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    await assertSafeUrl(url);
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

export default async function scrapeAndScript(job: JobInput): Promise<void> {
  const runId = job?.data?.runId;
  if (!runId) throw new Error('scrape-and-script job missing runId');
  const supabase = serviceClient();
  const log = (m: string) => console.log(`[vehicle-video] scrape-and-script ${runId}: ${m}`);
  const isFinalAttempt = (job?.attemptsMade ?? 0) + 1 >= (job?.opts?.attempts ?? 1);

  const setRun = async (fields: Record<string, unknown>) =>
    supabase.from('vehicle_videos').update(fields).eq('id', runId);

  const { data: run, error: runErr } = await supabase
    .from('vehicle_videos').select('*').eq('id', runId).single();
  if (runErr || !run) throw new Error(`run ${runId} not found: ${runErr?.message}`);

  try {
    // ── 1. Ingest ────────────────────────────────────────────────────────────
    let photoPaths: string[] = run.photo_paths ?? [];
    let vehicle: Record<string, unknown> = run.vehicle ?? {};
    let sellerLocation: string | null = null;

    if (run.input_mode === 'url') {
      await setRun({ script_status: 'scraping', error: null });
      const listingId = extractListingId(run.source_url);
      if (!listingId) {
        throw new VehicleVideoError('SCRAPE_BLOCKED_URL', 'scrape', `cannot resolve Auto Trader listing id from ${run.source_url}`);
      }
      const { imageUrls, details } = await fetchCarDetails(listingId, `run:${runId}`);
      if (!imageUrls.length) {
        throw new VehicleVideoError('SCRAPE_NO_IMAGES', 'scrape', 'Auto Trader listing had no usable images (try upload mode)');
      }
      vehicle = { ...details };
      sellerLocation = details.seller_location ?? null;

      photoPaths = [];
      let idx = 0;
      for (const u of imageUrls) {
        const raw = await fetchImageBuffer(u);
        if (!raw) continue;
        let norm;
        try {
          norm = await normalise(raw);
        } catch {
          continue;
        }
        const path = `${runPrefix(runId)}/photos/${String(idx).padStart(2, '0')}.jpg`;
        const { error } = await supabase.storage.from(BUCKET).upload(path, norm.buffer, {
          contentType: 'image/jpeg', upsert: true,
        });
        if (!error) {
          photoPaths.push(path);
          idx++;
        }
      }
      if (!photoPaths.length) {
        throw new VehicleVideoError('SCRAPE_NO_IMAGES', 'scrape', 'no images could be downloaded/normalised');
      }
      await setRun({ photo_paths: photoPaths, vehicle });
      log(`ingested ${photoPaths.length} images`);
    }

    if (!photoPaths.length) {
      throw new VehicleVideoError('SCRAPE_NO_IMAGES', 'scrape', 'no photos available (upload photos or provide a listing)');
    }

    // ── 2. Style ─────────────────────────────────────────────────────────────
    await setRun({ script_status: 'styling' });
    const market =
      run.market ??
      ([process.env.VEHICLE_VIDEO_MARKET, sellerLocation].filter(Boolean).join(' — ') || null);
    let profile;
    try {
      profile = await inferStyle(supabase, { vehicle, market });
    } catch (err) {
      log(`style inference failed (${(err as Error).message}); using neutral default`);
      profile = neutralDefaultProfile();
    }
    profile.vehicle_character = coerceCharacter(profile.vehicle_character);
    await setRun({ market, style_profile: profile });

    // ── 3. Shortlist + Script ────────────────────────────────────────────────
    await setRun({ script_status: 'scripting' });
    const visionMax = envInt('VEHICLE_VIDEO_VISION_MAX_IMAGES', 20);
    const maxShots = envInt('VEHICLE_VIDEO_MAX_SHOTS', 8);

    // Download normalised photos, dedup + cap for the vision call.
    const buffers: Buffer[] = [];
    for (const p of photoPaths) {
      const { data } = await supabase.storage.from(BUCKET).download(p);
      if (data) buffers.push(Buffer.from(await data.arrayBuffer()));
      else buffers.push(Buffer.alloc(0));
    }
    const short = await shortlist(buffers.filter((b) => b.length), visionMax);
    if (!short.length) throw new VehicleVideoError('SCRIPT_RECIPE_FAILED', 'script', 'no decodable images to shortlist');

    // The vision model sees shortlisted images 0..k-1; map its photo_index back
    // to the ORIGINAL gallery index (short[i].index) → storage path.
    const shortIndexToGallery = short.map((s) => s.index);
    const images = short.map((s) => ({ mimeType: 'image/jpeg', base64: s.buffer.toString('base64') }));

    let shotPlan: unknown = null;
    if (process.env.VEHICLE_VIDEO_SHOT_PLAN) {
      try { shotPlan = JSON.parse(process.env.VEHICLE_VIDEO_SHOT_PLAN); } catch { /* ignore */ }
    }
    const templateBody = await styleTemplateBody(supabase, profile.vehicle_character);

    const storyboard = await curateShots(supabase, {
      vehicle,
      images,
      shotPlan,
      styleTemplateBody: templateBody,
      style: profile.style,
      maxShots,
    });

    // Merge AI identification into the vehicle record.
    if (storyboard.identification) {
      vehicle = { ...vehicle, ...cleanId(storyboard.identification) };
    }

    // Write shot rows. Map photo_index (shortlisted) → gallery index → path.
    await supabase.from('vehicle_video_shots').delete().eq('vehicle_video_id', runId);
    const galleryPath = (shortIdx: number): string | null => {
      const g = shortIndexToGallery[shortIdx];
      return g != null && photoPaths[g] ? photoPaths[g] : null;
    };
    let seq = 0;
    for (const s of storyboard.shots) {
      const primary = galleryPath(s.photo_index) ?? photoPaths[0];
      const alts = (s.alt_photo_indices ?? [])
        .map((i) => galleryPath(i))
        .filter((p): p is string => !!p && p !== primary);
      await supabase.from('vehicle_video_shots').insert({
        vehicle_video_id: runId,
        seq: seq++,
        beat: s.beat,
        part: s.part ?? null,
        photo_path: primary,
        alt_photo_paths: alts,
        scene_title: s.scene_title ?? null,
        narration: s.narration ?? null,
        camera_prompt: s.camera_prompt ?? null,
        clip_status: 'planned',
        approval_status: 'pending',
      });
    }

    await setRun({
      vehicle,
      storyboard,
      shot_plan: shotPlan,
      script_status: 'ready_for_review',
      error: null,
    });
    log(`ready_for_review with ${storyboard.shots.length} shots (character ${profile.vehicle_character})`);
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 1000);
    log(`failed: ${message}`);
    if (isFinalAttempt) {
      await setRun({ script_status: 'failed', error: toStructuredError(err, 'scrape') });
    }
    throw err;
  }
}

function extractListingId(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null;
  const m = String(sourceUrl).match(/car-details\/(\d{6,})/);
  if (m) return m[1];
  if (/^\d{6,}$/.test(String(sourceUrl))) return String(sourceUrl);
  return null;
}

function cleanId(id: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['year', 'make', 'model', 'trim', 'id_source', 'id_confidence']) {
    if (id[k] != null && String(id[k]).trim()) out[k] = id[k];
  }
  return out;
}
