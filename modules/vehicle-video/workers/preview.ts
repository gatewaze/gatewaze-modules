// @ts-nocheck — supabase-js + sibling-module libs resolved at module-host install time.

/**
 * vehicle-video:preview — FREE (no Veo) whole-video motion preview. Generates
 * the voiceover (recipe) → Gemini TTS → a Ken Burns pan/zoom clip per kept shot
 * (ffmpeg over the still photo) → composed preview MP4. Lets the operator check
 * framing + pacing + the voiceover for ~£0 before spending on real Veo clips.
 */

import { serviceClient } from '../lib/service-client.js';
import { voiceover, styleTemplateBody } from '../lib/recipes.js';
import { synthesize } from '../lib/tts.js';
import { ffmpegPath, compose } from '../lib/compose.js';
import { kenBurnsClip } from '../lib/preview.js';
import { resolveWatermark, applyWatermark } from '../lib/watermark.js';
import { runPrefix } from '../lib/storage.js';
import { toStructuredError, VehicleVideoError } from '../lib/errors.js';

interface JobInput {
  data: { runId?: string };
  attemptsMade?: number;
  opts?: { attempts?: number };
}

const BUCKET = process.env.HOST_MEDIA_BUCKET ?? 'media';
const PREVIEW_SECONDS = 6; // shorter than a full Veo clip — it's a framing/pacing check

export default async function previewWorker(job: JobInput): Promise<void> {
  const runId = job?.data?.runId;
  if (!runId) throw new Error('preview job missing runId');
  const supabase = serviceClient();
  const log = (m: string) => console.log(`[vehicle-video] preview ${runId}: ${m}`);
  const isFinalAttempt = (job?.attemptsMade ?? 0) + 1 >= (job?.opts?.attempts ?? 1);
  const setRun = async (f: Record<string, unknown>) => supabase.from('vehicle_videos').update(f).eq('id', runId);

  const { data: run } = await supabase.from('vehicle_videos').select('*').eq('id', runId).single();
  if (!run) throw new Error(`run ${runId} not found`);

  try {
    const { data: shots } = await supabase
      .from('vehicle_video_shots').select('*')
      .eq('vehicle_video_id', runId).eq('kept', true).order('seq');
    if (!shots?.length) throw new VehicleVideoError('COMPOSE_FAILED', 'finalize', 'no kept shots to preview');

    const ffmpeg = await ffmpegPath();
    const style = run.style_profile?.style ?? { pacing: 'balanced', camera_energy: 'moderate', tone: 'confident', voice: 'Kore' };
    const durations = shots.map(() => PREVIEW_SECONDS);
    const totalDuration = durations.reduce((a, b) => a + b, 0);

    // ── voiceover script (recipe) + TTS ──────────────────────────────────────
    let wav: Buffer | null = null;
    try {
      const templateBody = await styleTemplateBody(supabase, run.style_profile?.vehicle_character ?? 'executive');
      const vo = await voiceover(supabase, {
        shots: shots.map((s) => ({ scene_title: s.scene_title ?? '', narration: s.narration ?? '' })),
        totalDurationSeconds: totalDuration,
        vehicle: run.vehicle ?? {},
        style,
        styleTemplateBody: templateBody,
      });
      await setRun({ voiceover_text: vo.voiceover });
      const accent = style.accent ? `${style.accent}` : `a natural ${style.tone ?? ''} delivery`;
      wav = await synthesize(vo.voiceover, {
        voice: run.video_config?.voice ?? style.voice,
        style: `Read this vehicle advert voiceover aloud in ${accent}. Keep it genuine and unhurried; read prices and numbers naturally as full words.`,
      });
    } catch (err) {
      log(`voiceover/TTS failed (${(err as Error).message}); preview will be silent`);
    }

    // ── Ken Burns clip per shot ──────────────────────────────────────────────
    const clips: Buffer[] = [];
    for (const s of shots) {
      const { data } = await supabase.storage.from(BUCKET).download(s.photo_path);
      if (!data) continue;
      const photo = Buffer.from(await data.arrayBuffer());
      clips.push(await kenBurnsClip(ffmpeg, photo, s.camera_prompt, PREVIEW_SECONDS));
    }
    if (!clips.length) throw new VehicleVideoError('COMPOSE_FAILED', 'finalize', 'no photos to build a preview');

    // ── compose ──────────────────────────────────────────────────────────────
    let mp4 = await compose({ clips, clipDurations: durations, narrationWav: wav });
    // watermark preview too, so the operator sees exactly what the final will look like
    const wm = await resolveWatermark(supabase);
    if (wm.enabled && wm.logo_path) {
      const { data: logoData } = await supabase.storage.from(BUCKET).download(wm.logo_path);
      if (logoData) mp4 = await applyWatermark(mp4, Buffer.from(await logoData.arrayBuffer()), wm);
    }
    const outPath = `${runPrefix(runId)}/preview.mp4`;
    const { error } = await supabase.storage.from(BUCKET).upload(outPath, mp4, { contentType: 'video/mp4', upsert: true });
    if (error) throw new VehicleVideoError('STORAGE_FAILED', 'finalize', `preview upload: ${error.message}`);

    await setRun({ preview_path: outPath, preview_status: 'ready', error: null });
    log(`preview ready → ${outPath} (${clips.length} shots)`);
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 1000);
    log(`failed: ${message}`);
    if (isFinalAttempt) await setRun({ preview_status: 'failed', error: toStructuredError(err, 'finalize') });
    throw err;
  }
}
