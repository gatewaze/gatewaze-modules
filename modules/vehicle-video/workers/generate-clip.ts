// @ts-nocheck — supabase-js + sibling-module libs resolved at module-host install time.

/**
 * vehicle-video:generate-clip — Phase B (ONE shot; the expensive step).
 *
 * Guarded by the cost ceiling + regen cap. Shapes the Veo prompt, submits the
 * chosen source image, polls to completion, downloads + stores the clip, and
 * leaves it approval_status='pending' for Gate 2. Resumable: a retry that finds
 * an existing veo_operation re-polls instead of re-submitting (no re-pay).
 */

import { serviceClient, envInt } from '../lib/service-client.js';
import { clipPrompt, styleTemplateBody, isExteriorBeat } from '../lib/recipes.js';
import { submitClip, awaitClip, downloadClip, activeProvider, clipDurationSeconds } from '../lib/video-provider.js';
import { falUpload } from '../lib/kling.js';
import { stripAudio } from '../lib/compose.js';
import { runPrefix } from '../lib/storage.js';
import { toStructuredError, VehicleVideoError } from '../lib/errors.js';

interface JobInput {
  data: { runId?: string; shotId?: string };
  attemptsMade?: number;
  opts?: { attempts?: number };
}

const BUCKET = process.env.HOST_MEDIA_BUCKET ?? 'media';

/**
 * Up to 3 real reference angles of the car (front/side/rear) hosted on fal, so
 * Kling keeps the exact car — number plate, colour, wheels — accurate under
 * motion (references fixed the plate-digit drift in testing). Uploaded once per
 * run and cached on video_config.reference_urls; Kling caps references at 3.
 */
async function resolveReferenceUrls(supabase: any, run: any, sourcePath: string): Promise<string[]> {
  if (activeProvider() !== 'kling') return [];
  const cached = run?.video_config?.reference_urls;
  if (Array.isArray(cached) && cached.length) return cached;
  const { data: shots } = await supabase
    .from('vehicle_video_shots').select('photo_path, beat, part').eq('vehicle_video_id', run.id).eq('kept', true).order('seq');
  const paths: string[] = [];
  for (const s of shots ?? []) {
    if (isExteriorBeat(s.beat, s.part) && s.photo_path && !paths.includes(s.photo_path)) paths.push(s.photo_path);
    if (paths.length >= 3) break;
  }
  if (!paths.length && sourcePath) paths.push(sourcePath);
  const urls: string[] = [];
  for (const p of paths.slice(0, 3)) {
    try {
      const { data } = await supabase.storage.from(BUCKET).download(p);
      if (data) urls.push(await falUpload(Buffer.from(await data.arrayBuffer()), 'image/jpeg'));
    } catch {
      /* skip a bad reference */
    }
  }
  if (urls.length) {
    await supabase.from('vehicle_videos')
      .update({ video_config: { ...(run.video_config ?? {}), reference_urls: urls } }).eq('id', run.id);
  }
  return urls;
}

function clipCostMicroUsd(): number {
  // Kling (fal.ai) ≈ $0.084/sec; Veo fast ≈ $1.20/clip, standard ≈ $3.20/clip.
  if (activeProvider() === 'kling') return Math.round(clipDurationSeconds() * 84_000);
  return (process.env.VEHICLE_VIDEO_VEO_MODEL ?? 'fast') === 'standard' ? 3_200_000 : 1_200_000;
}

export default async function generateClip(job: JobInput): Promise<void> {
  const { runId, shotId } = job?.data ?? {};
  if (!runId || !shotId) throw new Error('generate-clip job missing runId/shotId');
  const supabase = serviceClient();
  const log = (m: string) => console.log(`[vehicle-video] generate-clip ${shotId}: ${m}`);
  const isFinalAttempt = (job?.attemptsMade ?? 0) + 1 >= (job?.opts?.attempts ?? 1);

  const setShot = async (fields: Record<string, unknown>) =>
    supabase.from('vehicle_video_shots').update(fields).eq('id', shotId);

  const { data: shot } = await supabase.from('vehicle_video_shots').select('*').eq('id', shotId).single();
  const { data: run } = await supabase.from('vehicle_videos').select('*').eq('id', runId).single();
  if (!shot || !run) throw new Error('shot or run not found');
  if (!shot.kept) { log('shot dropped — skipping'); return; }

  try {
    // ── cost ceiling + regen cap ──────────────────────────────────────────────
    const maxRegens = envInt('VEHICLE_VIDEO_MAX_REGENS', 3);
    if ((shot.regen_count ?? 0) > maxRegens) {
      throw new VehicleVideoError('REGEN_LIMIT_REACHED', 'clip', `regen limit (${maxRegens}) reached`);
    }
    const perClip = clipCostMicroUsd();
    const maxCost = Number(process.env.VEHICLE_VIDEO_MAX_COST_MICRO_USD);
    if (Number.isFinite(maxCost) && maxCost > 0 && (run.cost_micro_usd ?? 0) + perClip > maxCost) {
      throw new VehicleVideoError('COST_CEILING_EXCEEDED', 'clip', 'per-run Veo cost ceiling would be exceeded');
    }

    // ── resume: if we already have an operation and no clip, re-poll ──────────
    let operation: string | null = shot.veo_operation ?? null;
    // The chosen photo, cycling through alternates on regeneration.
    let sourcePath: string = shot.photo_path;
    const alts: string[] = shot.alt_photo_paths ?? [];
    if ((shot.current_alt_index ?? 0) > 0 && alts.length) {
      sourcePath = alts[(shot.current_alt_index - 1) % alts.length] ?? shot.photo_path;
    }

    if (!operation) {
      // shape the Veo prompt
      await setShot({ clip_status: 'prompting', error: null });
      const templateBody = await styleTemplateBody(supabase, run.style_profile?.vehicle_character ?? 'executive');
      const clip = await clipPrompt(supabase, {
        shot: { part: shot.part, scene_title: shot.scene_title, camera_prompt: shot.camera_prompt },
        vehicle: run.vehicle ?? {},
        style: run.style_profile?.style ?? { pacing: 'balanced', camera_energy: 'moderate', tone: 'confident', voice: 'Orus' },
        styleTemplateBody: templateBody,
      });
      const { veo_prompt, negative_prompt } = clip;
      // Surface a fidelity warning (strict-fidelity: the move was reduced to a safe
      // one because this single photo can't support the fuller shot — the operator
      // should add more angles).
      await setShot({
        fidelity_note: clip.fidelity_note ?? null,
        needs_more_images: clip.needs_more_images ?? false,
      });

      // download the source image
      const { data: imgData } = await supabase.storage.from(BUCKET).download(sourcePath);
      if (!imgData) throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', `source image missing: ${sourcePath}`);
      const imageBase64 = Buffer.from(await imgData.arrayBuffer()).toString('base64');

      // Real reference angles keep the exact car accurate under motion (Kling).
      const referenceImageUrls = await resolveReferenceUrls(supabase, run, sourcePath);

      await setShot({ clip_status: 'submitted', veo_prompt });
      operation = await submitClip({ imageBase64, imageMimeType: 'image/jpeg', prompt: veo_prompt, negativePrompt: negative_prompt, referenceImageUrls });
      await setShot({ veo_operation: operation, clip_status: 'polling' });
      // Account the spend at submit time (Veo bills per generation).
      await supabase.from('vehicle_videos')
        .update({ cost_micro_usd: (run.cost_micro_usd ?? 0) + perClip })
        .eq('id', runId);
    } else {
      await setShot({ clip_status: 'polling' });
    }

    // ── poll + download ──────────────────────────────────────────────────────
    const uri = await awaitClip(operation);
    // Strip Veo's generated soundtrack — clips are silent building blocks; our
    // TTS voiceover is the only audio, added at compose.
    const clipBuf = await stripAudio(await downloadClip(uri));
    const clipPath = `${runPrefix(runId)}/clips/${shot.seq}-${Date.now()}.mp4`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(clipPath, clipBuf, {
      contentType: 'video/mp4', upsert: true,
    });
    if (upErr) throw new VehicleVideoError('STORAGE_FAILED', 'clip', `clip upload: ${upErr.message}`);

    await setShot({
      clip_path: clipPath,
      clip_duration_s: clipDurationSeconds(),
      clip_status: 'generated',
      approval_status: 'pending',
      error: null,
    });
    log('clip generated (pending approval)');
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 1000);
    log(`failed: ${message}`);
    if (isFinalAttempt) await setShot({ clip_status: 'failed', error: toStructuredError(err, 'clip') });
    throw err;
  }
}
