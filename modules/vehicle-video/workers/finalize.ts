// @ts-nocheck — supabase-js + sibling-module libs resolved at module-host install time.

/**
 * vehicle-video:finalize — Phase C (voiceover + compose). Runs after every kept
 * shot is approved. Generates the voiceover script (recipe) → Gemini TTS → WAV,
 * then composes the approved clips + narration into the final MP4 (no music, v1).
 */

import { serviceClient } from '../lib/service-client.js';
import { voiceover, styleTemplateBody } from '../lib/recipes.js';
import { synthesize } from '../lib/tts.js';
import { compose } from '../lib/compose.js';
import { resolveWatermark, applyWatermark } from '../lib/watermark.js';
import { runPrefix } from '../lib/storage.js';
import { toStructuredError, VehicleVideoError } from '../lib/errors.js';

interface JobInput {
  data: { runId?: string };
  attemptsMade?: number;
  opts?: { attempts?: number };
}

const BUCKET = process.env.HOST_MEDIA_BUCKET ?? 'media';
const TTS_COST_MICRO_USD = 50_000; // best-effort flat estimate per run

export default async function finalize(job: JobInput): Promise<void> {
  const runId = job?.data?.runId;
  if (!runId) throw new Error('finalize job missing runId');
  const supabase = serviceClient();
  const log = (m: string) => console.log(`[vehicle-video] finalize ${runId}: ${m}`);
  const isFinalAttempt = (job?.attemptsMade ?? 0) + 1 >= (job?.opts?.attempts ?? 1);

  const setRun = async (fields: Record<string, unknown>) =>
    supabase.from('vehicle_videos').update(fields).eq('id', runId);

  const { data: run } = await supabase.from('vehicle_videos').select('*').eq('id', runId).single();
  if (!run) throw new Error(`run ${runId} not found`);

  try {
    const { data: shots } = await supabase
      .from('vehicle_video_shots').select('*')
      .eq('vehicle_video_id', runId).eq('kept', true).eq('approval_status', 'approved')
      .order('seq');
    if (!shots?.length) {
      throw new VehicleVideoError('SHOTS_NOT_ALL_APPROVED', 'finalize', 'no approved shots to compose');
    }

    // ── 1. Voiceover script ───────────────────────────────────────────────────
    const durations = shots.map((s) => Number(s.clip_duration_s) || 8);
    const totalDuration = durations.reduce((a, b) => a + b, 0);
    const style = run.style_profile?.style ?? { pacing: 'balanced', camera_energy: 'moderate', tone: 'confident', voice: 'Kore' };
    const templateBody = await styleTemplateBody(supabase, run.style_profile?.vehicle_character ?? 'executive');

    const vo = await voiceover(supabase, {
      shots: shots.map((s) => ({ scene_title: s.scene_title ?? '', narration: s.narration ?? '' })),
      totalDurationSeconds: totalDuration,
      vehicle: run.vehicle ?? {},
      style,
      styleTemplateBody: templateBody,
    });
    await setRun({ voiceover_text: vo.voiceover });

    // ── 2. TTS ────────────────────────────────────────────────────────────────
    const voice = run.video_config?.voice ?? style.voice;
    const accent = style.accent ? `${style.accent}` : `a natural ${style.tone ?? ''} delivery`;
    const wav = await synthesize(vo.voiceover, {
      voice,
      style: `Read this vehicle advert voiceover aloud in ${accent}. Keep it genuine and unhurried; read prices and numbers naturally as full words.`,
    });

    // ── 3. Compose ────────────────────────────────────────────────────────────
    const clips: Buffer[] = [];
    for (const s of shots) {
      if (!s.clip_path) throw new VehicleVideoError('COMPOSE_FAILED', 'finalize', `approved shot ${s.seq} has no clip`);
      const { data } = await supabase.storage.from(BUCKET).download(s.clip_path);
      if (!data) throw new VehicleVideoError('COMPOSE_FAILED', 'finalize', `clip missing: ${s.clip_path}`);
      clips.push(Buffer.from(await data.arrayBuffer()));
    }
    let mp4 = await compose({ clips, clipDurations: durations, narrationWav: wav });

    // ── watermark (dealer logo overlay) ───────────────────────────────────────
    const wm = await resolveWatermark(supabase);
    if (wm.enabled && wm.logo_path) {
      const { data: logoData } = await supabase.storage.from(BUCKET).download(wm.logo_path);
      if (logoData) {
        const logo = Buffer.from(await logoData.arrayBuffer());
        mp4 = await applyWatermark(mp4, logo, wm);
      }
    }

    const outPath = `${runPrefix(runId)}/output.mp4`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(outPath, mp4, {
      contentType: 'video/mp4', upsert: true,
    });
    if (upErr) throw new VehicleVideoError('STORAGE_FAILED', 'finalize', `output upload: ${upErr.message}`);

    await setRun({
      video_path: outPath,
      video_status: 'complete',
      cost_micro_usd: (run.cost_micro_usd ?? 0) + TTS_COST_MICRO_USD,
      error: null,
    });
    log(`complete → ${outPath} (${shots.length} shots, ${totalDuration}s)`);
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 1000);
    log(`failed: ${message}`);
    if (isFinalAttempt) await setRun({ video_status: 'failed', error: toStructuredError(err, 'finalize') });
    throw err;
  }
}
