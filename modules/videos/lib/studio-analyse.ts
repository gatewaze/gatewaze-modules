// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * The analysis pass over one master, start to finish.
 *
 *   1. download the master, probe it
 *   2. sample a small frame every N seconds (one ffmpeg pass: JPEGs for the
 *      model, gray raw for the local stats)
 *   3. local stats per frame: sharpness, composite layout, near-white share
 *   4. twelve speaker candidates and ten slide candidates to the vision model
 *   5. full-resolution stills of the best speaker frames, cut out, gated by
 *      Dan's three rules; more candidates from the least-white frames when
 *      fewer than three pass; the least bad flagged when none does
 *   6. slide panels verified at full resolution, nobody in them
 *   7. a filmstrip for the trim timeline
 *   8. three headline drafts from the programme text
 *
 * Progress is written to the studio row as it goes, so the editor watching
 * the page sees which step is running. Every working image goes to the
 * media bucket; the master's temp copy is deleted at the end whatever
 * happened.
 */

import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, ffmpegBytes, probe, tsArg } from './ffmpeg.js';
import { vision, text as llmText, falConfigured } from './fal.js';
import { frameStats, type FrameStats } from './studio-pixels.js';
import {
  planCandidates, rankSpeakerFrames, rankSlideFrames, panelPasses, cutPasses, leastBad, lowGlareCandidates,
  cameraCrop, slideCrop, isCloseShot, SPEAKER_RUBRIC, SLIDE_RUBRIC, PANEL_VERIFY_RUBRIC,
  type SampledFrame, type SpeakerScore, type SlideScore,
} from './studio-analysis.js';
import { cutOut } from './cutout.js';
import { headlinePrompt, parseHeadlines, fallbackHeadline, HEADLINE_SYSTEM, type Headline } from './headlines.js';
import { loadStudioContext, type StudioContext } from './studio-context.js';
import { downloadMaster, putMedia, studioFolder } from './studio-media.js';

const CONTACT_W = 640;
const CONTACT_H = 360;
/** Sampled frames per video, at most. */
const MAX_SAMPLES = 300;
const VISION_CONCURRENCY = 6;
const CUT_CONCURRENCY = 2;

export const DEFAULT_MAX_MASTER_BYTES = 8 * 1024 * 1024 * 1024;

export interface AnalysisCut {
  key: string;
  t: number;
  path: string;
  bbox: [number, number, number, number] | null;
  meta: SpeakerScore;
  glare: number;
  screen: number;
  luma: number;
  gamma: number;
  lectern_joined: boolean;
  camera_crop: boolean;
  passes: boolean;
  flagged?: string;
}

export interface AnalysisPanel { key: string; t: number; path: string; note: string; composite: boolean }

export interface Analysis {
  version: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  sample_every: number;
  sampled: number;
  layout: { strip: number; overlay: number; plain: number; camera_only: boolean };
  filmstrip: { path: string; columns: number; rows: number; cell_w: number; cell_h: number; every: number; count: number; start: number } | null;
  cuts: AnalysisCut[];
  panels: AnalysisPanel[];
  model_calls: number;
  context: StudioContext;
}

type Log = (m: string) => void;

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const run = async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      out[k] = await fn(items[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  return out;
}

function frac(bb: { x0: number; y0: number; x1: number; y1: number } | null, w: number, h: number): [number, number, number, number] | null {
  return bb ? [Number((bb.x0 / w).toFixed(3)), Number((bb.y0 / h).toFixed(3)), Number((bb.x1 / w).toFixed(3)), Number((bb.y1 / h).toFixed(3))] : null;
}

export interface AnalyseArgs {
  studioId: string;
  videoId: string;
  asset: { id: string; storage_provider?: string | null; storage_bucket: string; storage_path: string; bytes?: number | null };
  maxMasterBytes?: number;
  sampleEvery?: number;
  progress: (line: string) => Promise<void>;
  log?: Log;
}

export async function analyseMaster(supabase, args: AnalyseArgs): Promise<{ analysis: Analysis; headlines: Headline[] }> {
  if (!falConfigured()) throw new Error('FAL_API_KEY is not configured on the worker');
  const log = args.log ?? (() => {});
  const folder = studioFolder(args.videoId, args.studioId);
  let calls = 0;

  await args.progress('Fetching the master');
  const master = await downloadMaster(supabase, args.asset, args.maxMasterBytes ?? DEFAULT_MAX_MASTER_BYTES);
  const work = await mkdtemp(join(tmpdir(), 'studio-analyse-'));
  try {
    const p = await probe(master.path);
    const W = p.width; const H = p.height;
    const every = Math.max(args.sampleEvery ?? 10, Math.ceil(p.durationSeconds / MAX_SAMPLES));
    log(`master ${W}x${H} ${p.durationSeconds.toFixed(0)}s, sampling every ${every}s`);

    // 2. Sample. One pass; the gray copy of each frame comes back on stdout.
    await args.progress('Sampling frames');
    const start = p.durationSeconds * 0.03;
    const span = p.durationSeconds * 0.94;
    const frames = join(work, 'frames');
    await mkdir(frames, { recursive: true });
    const gray = await ffmpegBytes([
      '-ss', tsArg(start), '-t', tsArg(span), '-i', master.path,
      '-filter_complex', `[0:v]fps=1/${every},scale=${CONTACT_W}:${CONTACT_H},split[a][b];[b]format=gray[g]`,
      '-map', '[a]', '-q:v', '3', join(frames, '%05d.jpg'),
      '-map', '[g]', '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ]);
    const jpgs = (await readdir(frames)).filter((f) => f.endsWith('.jpg')).sort();
    const perFrame = CONTACT_W * CONTACT_H;
    const count = Math.min(jpgs.length, Math.floor(gray.length / perFrame));
    const sampled: SampledFrame[] = [];
    const jpgAt = new Map<number, string>();
    for (let k = 0; k < count; k++) {
      const t = Math.round(start + k * every);
      const stats: FrameStats = frameStats(gray.subarray(k * perFrame, (k + 1) * perFrame), CONTACT_W, CONTACT_H);
      sampled.push({ t, stats });
      jpgAt.set(t, join(frames, jpgs[k]));
    }
    if (!sampled.length) throw new Error('no frames could be sampled');

    // 3 and 4. Plan, then score.
    const plan = planCandidates(sampled);
    const layoutCounts = { strip: 0, overlay: 0, plain: 0 };
    for (const f of sampled) layoutCounts[plan.layouts[f.t] ?? 'plain'] += 1;
    log(`${sampled.length} frames: ${layoutCounts.strip} strip, ${layoutCounts.overlay} overlay, ${layoutCounts.plain} plain; camera-only ${plan.cameraOnly}`);
    await args.progress(`Scoring ${plan.speaker.length + plan.slide.length} frames with the vision model`);

    const cropContact = async (t: number, box: [number, number, number, number], outW: number, name: string): Promise<string> => {
      const sx = CONTACT_W / W; const sy = CONTACT_H / H;
      const [x, y, w, h] = box;
      const out = join(work, `${name}_${t}.jpg`);
      await ffmpeg(['-i', jpgAt.get(t) as string, '-vf', `crop=${Math.round(w * sx)}:${Math.round(h * sy)}:${Math.round(x * sx)}:${Math.round(y * sy)},scale=${outW}:-2:flags=lanczos`, '-q:v', '3', out]);
      return out;
    };
    const speakerScored = await pool(plan.speaker, VISION_CONCURRENCY, async (t) => {
      try {
        let path = jpgAt.get(t) as string;
        const cam = plan.cameraOnly ? cameraCrop(plan.layouts[t], W) : null;
        if (cam) path = await cropContact(t, cam, 480, 'cam');
        calls += 1;
        const score = (await vision(await readFile(path), SPEAKER_RUBRIC)) as SpeakerScore;
        return { t, score, sharp: sampled.find((f) => f.t === t)?.stats.sharp ?? 0 };
      } catch (err) {
        log(`speaker score ${t}: ${String((err as Error).message).slice(0, 120)}`);
        return { t, score: {} as SpeakerScore, sharp: 0 };
      }
    });
    const slideScored = await pool(plan.slide, VISION_CONCURRENCY, async (t) => {
      try {
        let path = jpgAt.get(t) as string;
        const box = slideCrop(plan.layouts[t], W);
        if (box) path = await cropContact(t, box, 828, 'slide');
        calls += 1;
        return { t, score: (await vision(await readFile(path), SLIDE_RUBRIC)) as SlideScore };
      } catch (err) {
        log(`slide score ${t}: ${String((err as Error).message).slice(0, 120)}`);
        return { t, score: {} as SlideScore };
      }
    });

    // 5. Cut-outs.
    const still = async (t: number): Promise<Buffer> => {
      const out = join(work, `full_${t}.jpg`);
      await ffmpeg(['-ss', tsArg(t), '-i', master.path, '-frames:v', '1', '-q:v', '2', out]);
      return readFile(out);
    };
    const cuts: AnalysisCut[] = [];
    const tried = new Set<number>();
    const makeCut = async (t: number, score: SpeakerScore): Promise<AnalysisCut | null> => {
      tried.add(t);
      try {
        const frame = await still(t);
        const cam = plan.cameraOnly ? cameraCrop(plan.layouts[t], W) : null;
        calls += score.lectern ? 5 : 3;
        const r = await cutOut({ frame, width: W, height: H, cameraCrop: cam, lectern: score.lectern === true });
        const key = `cut-${t}`;
        const path = await putMedia(supabase, `${folder}/${key}.png`, r.png, 'image/png');
        return {
          key, t, path, bbox: frac(r.bbox, W, H), meta: score, glare: r.glare, screen: r.screen, luma: r.meanLuma, gamma: r.gamma,
          lectern_joined: r.lecternJoined, camera_crop: Boolean(cam),
          passes: cutPasses({ bbox: r.bbox, glare: r.glare, screen: r.screen }, W, H),
        };
      } catch (err) {
        log(`cut-out ${t}: ${String((err as Error).message).slice(0, 160)}`);
        return null;
      }
    };
    const ranked = rankSpeakerFrames(speakerScored);
    await args.progress(`Cutting the speaker out of ${Math.min(4, ranked.length)} frames`);
    for (const c of await pool(ranked.slice(0, 4), CUT_CONCURRENCY, (r) => makeCut(r.t, r.score))) if (c) cuts.push(c);

    if (cuts.filter((c) => c.passes).length < 3) {
      // More candidates from the frames with the least projector white.
      const more = lowGlareCandidates(sampled, plan.layouts, tried, 12);
      if (more.length) {
        await args.progress('Looking for frames without projector glare');
        const scored = await pool(more, VISION_CONCURRENCY, async (t) => {
          try { calls += 1; return { t, score: (await vision(await readFile(jpgAt.get(t) as string), SPEAKER_RUBRIC)) as SpeakerScore }; } catch { return { t, score: {} as SpeakerScore }; }
        });
        const ok = scored
          .filter((s) => s.score.kind === 'speaker' && s.score.size !== 'small')
          .sort((a, b) => ((10 - (Number(a.score.glare) || 0)) * 0.5 + (Number(a.score.face) || 0) * 0.3 + (Number(a.score.pose) || 0) * 0.2)
            < ((10 - (Number(b.score.glare) || 0)) * 0.5 + (Number(b.score.face) || 0) * 0.3 + (Number(b.score.pose) || 0) * 0.2) ? 1 : -1);
        for (const c of await pool(ok.slice(0, 4), CUT_CONCURRENCY, (r) => makeCut(r.t, r.score))) if (c) cuts.push(c);
      }
    }
    const passing = cuts.filter((c) => c.passes);
    let finalCuts: AnalysisCut[];
    if (passing.length) {
      finalCuts = passing.slice(0, 3);
    } else {
      const lb = leastBad(cuts.map((c) => ({ ...c, bbox: c.bbox ? { x0: c.bbox[0] * W, y0: c.bbox[1] * H, x1: c.bbox[2] * W, y1: c.bbox[3] * H } : null })), W, H);
      finalCuts = lb ? [{ ...cuts.find((c) => c.key === lb.key) as AnalysisCut, flagged: 'no clean frame: the speaker is in front of the screen throughout' }] : [];
    }
    log(`${cuts.length} cut-outs made, ${passing.length} pass; keeping ${finalCuts.length}`);

    // 6. Panels at full resolution.
    await args.progress('Checking slides for the background');
    const panels: AnalysisPanel[] = [];
    let triedPanels = 0;
    for (const s of rankSlideFrames(slideScored)) {
      if (panels.length === 2 || triedPanels >= 6) break;
      triedPanels += 1;
      try {
        const box = slideCrop(plan.layouts[s.t], W);
        const out = join(work, `panel_${s.t}.jpg`);
        await ffmpeg(['-ss', tsArg(s.t), '-i', master.path, '-frames:v', '1', ...(box ? ['-vf', `crop=${box[2]}:${box[3]}:${box[0]}:${box[1]}`] : []), '-q:v', '2', out]);
        calls += 1;
        const v = (await vision(await readFile(out), PANEL_VERIFY_RUBRIC)) as SlideScore;
        if (!panelPasses(v)) continue;
        const small = join(work, `panel_${s.t}_1280.jpg`);
        await ffmpeg(['-i', out, '-vf', 'scale=1280:-2:flags=lanczos', '-q:v', '4', small]);
        const key = `panel-${s.t}`;
        const path = await putMedia(supabase, `${folder}/${key}.jpg`, await readFile(small), 'image/jpeg');
        panels.push({ key, t: s.t, path, note: String(v.note ?? s.score.note ?? ''), composite: Boolean(box) });
      } catch (err) {
        log(`panel ${s.t}: ${String((err as Error).message).slice(0, 120)}`);
      }
    }

    // 7. Filmstrip for the trim timeline: every sampled frame at 160x90.
    await args.progress('Building the filmstrip');
    let filmstrip: Analysis['filmstrip'] = null;
    try {
      const columns = 10; const rows = Math.ceil(count / columns);
      const stripPath = join(work, 'filmstrip.jpg');
      await ffmpeg(['-i', join(frames, '%05d.jpg'), '-frames:v', String(count), '-vf', `scale=160:90,tile=${columns}x${rows}`, '-q:v', '5', stripPath]);
      const path = await putMedia(supabase, `${folder}/filmstrip.jpg`, await readFile(stripPath), 'image/jpeg');
      filmstrip = { path, columns, rows, cell_w: 160, cell_h: 90, every, count, start: Math.round(start) };
    } catch (err) {
      log(`filmstrip: ${String((err as Error).message).slice(0, 120)}`);
    }

    // 8. Headlines.
    await args.progress('Drafting headlines');
    const context = await loadStudioContext(supabase, args.videoId);
    let headlines: Headline[] = [];
    try {
      calls += 1;
      headlines = parseHeadlines(await llmText(headlinePrompt(context), HEADLINE_SYSTEM), context);
    } catch (err) {
      log(`headlines: ${String((err as Error).message).slice(0, 120)}`);
    }
    if (!headlines.length) headlines = [fallbackHeadline(context)];

    return {
      analysis: {
        version: 1, duration: Math.round(p.durationSeconds), width: W, height: H, fps: p.fps, sample_every: every, sampled: count,
        layout: { ...layoutCounts, camera_only: plan.cameraOnly }, filmstrip, cuts: finalCuts, panels, model_calls: calls, context,
      },
      headlines,
    };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
    await master.dispose();
  }
}

export { isCloseShot };
