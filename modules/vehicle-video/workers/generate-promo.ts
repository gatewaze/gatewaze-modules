// @ts-nocheck — supabase-js + sibling-module libs resolved at module-host install time.

/**
 * vehicle-video:generate-promo — the promo-assembler pipeline (the current
 * product direction). Given a run + a theme id, it:
 *   1. picks the car's real reference angles (front/side/rear), skipping studio/AI
 *      hero shots, and hosts them on fal;
 *   2. generates each of the theme's Kling shots from the right seed angle, with
 *      references + hardened negative + generate_audio:false (exact car, silent);
 *   3. assembles the finished promo — fast cuts, grade, kinetic captions, title
 *      card + Auto Trader CTA — and stores it.
 * Per-shot review/drop/regenerate lives in the admin UI; a dropped shot's edit
 * segments are simply skipped by the assembler.
 */

import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serviceClient } from '../lib/service-client.js';
import { klingSubmit, klingAwait, klingDownload, falUpload } from '../lib/kling.js';
import { getTheme, fillPrompt, FALLBACK_CONTENT } from '../lib/promo-themes.js';
import { resolvePromoContent } from '../lib/promo-content.js';
import { assemblePromo } from '../lib/promo-assemble.js';
import { isExteriorBeat } from '../lib/recipes.js';
import { runPrefix } from '../lib/storage.js';
import { toStructuredError, VehicleVideoError } from '../lib/errors.js';

interface JobInput {
  data: { runId?: string; themeId?: string };
  attemptsMade?: number;
  opts?: { attempts?: number };
}
const BUCKET = process.env.HOST_MEDIA_BUCKET ?? 'media';

// Hardened negative shared by every promo shot (fidelity rules proven in testing).
// NOTE caliper handling: red/coloured calipers are suppressed only when the car's
// own calipers are dark; a car with genuine coloured calipers relies on the
// references, so the caller can pass `suppressCalipers: false`.
function hardNegative(suppressCalipers: boolean, extra?: string): string {
  const base = [
    'a different car', 'changed colour', 'different wheels', 'changed wheel design',
    'altered ride height', 'reshaped headlights', 'invented badges',
    'changed number plate', 'altered registration', 'wrong number plate',
    'morphing bodywork', 'distorted panels', 'warping', 'floating car',
    'left-hand drive', 'added text', 'reversing', 'driving backwards',
    'camera shake', 'shaky camera', 'bouncing camera',
  ];
  if (suppressCalipers) base.push('red brake calipers', 'coloured brake calipers', 'painted calipers');
  if (extra) base.push(extra);
  return base.join(', ');
}

/** Real exterior photos for the front/side/rear seeds, skipping obvious studio shots. */
async function resolveAngles(supabase: any, runId: string): Promise<{ front?: string; side?: string; rear?: string; refs: string[] }> {
  const { data: shots } = await supabase
    .from('vehicle_video_shots').select('photo_path, beat, part').eq('vehicle_video_id', runId).eq('kept', true).order('seq');
  const ext = (shots ?? []).filter((s) => isExteriorBeat(s.beat, s.part) && s.photo_path);
  const find = (re: RegExp) => ext.find((s) => re.test(`${s.beat} ${s.part}`.toLowerCase()))?.photo_path;
  const front = find(/front|hero/) ?? ext[0]?.photo_path;
  const side = find(/profile|side/) ?? front;
  const rear = find(/rear/) ?? side;
  // up to 3 distinct references (Kling caps at 3)
  const refs: string[] = [];
  for (const p of [front, side, rear]) if (p && !refs.includes(p)) refs.push(p);
  return { front, side, rear, refs: refs.slice(0, 3) };
}

async function b64(supabase: any, path: string): Promise<string | null> {
  const { data } = await supabase.storage.from(BUCKET).download(path);
  return data ? Buffer.from(await data.arrayBuffer()).toString('base64') : null;
}

export default async function generatePromo(job: JobInput): Promise<void> {
  const { runId, themeId } = job?.data ?? {};
  if (!runId || !themeId) throw new Error('generate-promo missing runId/themeId');
  const supabase = serviceClient();
  const log = (m: string) => console.log(`[vehicle-video] generate-promo ${runId}: ${m}`);
  const isFinalAttempt = (job?.attemptsMade ?? 0) + 1 >= (job?.opts?.attempts ?? 1);
  const setRun = (f: Record<string, unknown>) => supabase.from('vehicle_videos').update(f).eq('id', runId);

  const theme = getTheme(themeId);
  if (!theme) throw new VehicleVideoError('SCRIPT_RECIPE_FAILED', 'script', `unknown promo theme: ${themeId}`, 400);
  // Prompt text + captions + title card come from the git theme skill (editable
  // without a redeploy); the inlined FALLBACK_CONTENT is only an emergency net.
  const content = (await resolvePromoContent(supabase, themeId)) ?? FALLBACK_CONTENT[themeId];
  if (!content) throw new VehicleVideoError('SCRIPT_RECIPE_FAILED', 'script', `no content for promo theme: ${themeId}`);
  const { data: run } = await supabase.from('vehicle_videos').select('*').eq('id', runId).single();
  if (!run) throw new Error(`run ${runId} not found`);

  const dir = await mkdtemp(join(tmpdir(), 'vv-shots-'));
  try {
    await setRun({ video_status: 'clips_in_progress', video_config: { ...(run.video_config ?? {}), theme: themeId }, error: null });

    const veh = run.vehicle ?? {};
    const car = [veh.colour, veh.year, veh.make, veh.model].filter(Boolean).join(' ') || 'car';
    const plate = String(veh.plate ?? veh.registration ?? '').trim();
    const suppressCalipers = (run.video_config?.suppress_calipers ?? true) !== false;

    const angles = await resolveAngles(supabase, runId);
    if (!angles.front) throw new VehicleVideoError('SCRIPT_RECIPE_FAILED', 'script', 'no usable exterior photo for the promo');

    // Host the reference angles on fal once.
    const refUrls: string[] = [];
    for (const p of angles.refs) {
      const bs = await b64(supabase, p);
      if (bs) refUrls.push(await falUpload(Buffer.from(bs, 'base64'), 'image/jpeg'));
    }

    // Generate each theme shot from the right seed angle.
    const shotPaths: Record<string, string> = {};
    for (const shot of theme.shots) {
      const seedPath = (angles as any)[shot.sourceAngle] ?? angles.front;
      const seed = await b64(supabase, seedPath);
      if (!seed) { log(`no seed for shot ${shot.key} — skipping`); continue; }
      const prompt = fillPrompt(content.shots[shot.key] ?? '', car, plate);
      if (!prompt) { log(`no prompt for shot ${shot.key} — skipping`); continue; }
      log(`generating shot "${shot.key}" (${shot.duration}s)`);
      const reqId = await klingSubmit({
        imageBase64: seed, imageMimeType: 'image/jpeg', prompt,
        negativePrompt: hardNegative(suppressCalipers, shot.negativeExtra),
        durationSeconds: shot.duration, referenceImageUrls: refUrls,
      });
      const url = await klingAwait(reqId);
      const buf = await klingDownload(url);
      const p = join(dir, `${shot.key}.mp4`);
      await writeFile(p, buf);
      shotPaths[shot.key] = p;
    }
    if (!Object.keys(shotPaths).length) throw new VehicleVideoError('COMPOSE_FAILED', 'finalize', 'no promo shots generated');

    // Assemble → store. Resolve caption/title-card copy from git content.
    await setRun({ video_status: 'finalizing' });
    const resolvedTheme = {
      grade: theme.grade,
      titleCard: content.titleCard,
      edit: theme.edit.map((s) => ({
        shotKey: s.shotKey, in: s.in, duration: s.duration,
        caption: s.captionKey ? content.captions[s.captionKey] : undefined,
      })),
    };
    const promo = await assemblePromo(shotPaths, resolvedTheme, car, plate);
    const outPath = `${runPrefix(runId)}/promo-${themeId}.mp4`;
    const { error } = await supabase.storage.from(BUCKET).upload(outPath, promo, { contentType: 'video/mp4', upsert: true });
    if (error) throw new VehicleVideoError('STORAGE_FAILED', 'finalize', `promo upload: ${error.message}`);
    await setRun({ video_path: outPath, video_status: 'complete', error: null });
    log(`promo complete → ${outPath}`);
  } catch (err) {
    log(`failed: ${String((err as Error)?.message ?? err).slice(0, 300)}`);
    if (isFinalAttempt) await setRun({ video_status: 'failed', error: toStructuredError(err, 'finalize') });
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
