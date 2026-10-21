/**
 * The talk card in front of a video, and the trim before it.
 *
 * The card is the AAIF opener measured off the existing uploads: the event
 * key art, the title in Figtree at 90px from x=200, the speaker line under
 * it, 4.24 seconds with the music sting. It is rendered as a PNG in Chromium
 * and encoded to match the master's own video and audio parameters, so the
 * join is a concat by stream copy and the talk itself is never re-encoded.
 * If the join does not verify (the durations do not add up, which is what
 * a parameter mismatch looks like), the whole output is re-encoded once as
 * the slow, safe path.
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, probe, tsArg, type ProbeResult } from './ffmpeg.js';
import { escapeHtml } from './artboard.js';
import { renderHtmlToPng } from './chromium.js';

export const CARD_SECONDS = 4.24;

export interface CardSpeaker { name: string; role?: string | null; company?: string | null }

export interface CardInput {
  title: string;
  speakers: CardSpeaker[];
}

/** Lines of 90px type the title takes at 1480px wide, from its length; the block centres around 42%. */
export function cardLayout(title: string): { lines: number; titleTop: number; whoTop: number } {
  const lines = title.length <= 34 ? 1 : title.length <= 70 ? 2 : 3;
  const titleTop = { 1: 420, 2: 346, 3: 286 }[lines] as number;
  return { lines, titleTop, whoTop: titleTop + lines * 104 + 30 };
}

/** The speaker line: name in bold, then role and company, speakers joined with a dot. */
export function whoLine(speakers: CardSpeaker[]): string {
  return speakers
    .filter((s) => s.name)
    .map((s) => `<b>${escapeHtml(s.name)}</b>${s.role ? `, ${escapeHtml(s.role)}` : ''}${s.company ? `, ${escapeHtml(s.company)}` : ''}`)
    .join(' · ');
}

export function cardHtml(input: CardInput, assets: { cardBg: string; figtree: string }): string {
  const { titleTop, whoTop } = cardLayout(input.title);
  return `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: "Figtree"; font-style: normal; font-weight: 300 900; src: url("${assets.figtree}") format("woff2"); }
html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #20223b; }
.card { position: relative; width: 1920px; height: 1080px; background: #20223b url("${assets.cardBg}") no-repeat 0 0; font-family: "Figtree", "Helvetica Neue", Arial, sans-serif; color: #fff; }
.title { position: absolute; left: 200px; top: ${titleTop}px; width: 1480px; font-weight: 500; font-size: 90px; line-height: 1.15; letter-spacing: -0.012em; text-wrap: balance; }
.who { position: absolute; left: 200px; top: ${whoTop}px; width: 1480px; font-weight: 400; font-size: 50px; line-height: 1.3; color: rgba(255,255,255,.82); }
.who b { font-weight: 600; color: #fff; }
</style><div class="card"><div class="title">${escapeHtml(input.title)}</div><div class="who">${whoLine(input.speakers)}</div></div>`;
}

export async function renderCardPng(input: CardInput, assets: { cardBg: string; figtree: string }): Promise<Buffer> {
  return renderHtmlToPng(cardHtml(input, assets), 1920, 1080, 1);
}

/** Encoder arguments that reproduce the master's stream parameters. */
export function matchArgs(p: ProbeResult): string[] {
  const fps = p.fps > 0 && p.fps <= 120 ? p.fps : 25;
  const profile = /high/i.test(p.videoProfile) ? 'high' : /main/i.test(p.videoProfile) ? 'main' : 'high';
  const rate = p.audioRate > 0 ? p.audioRate : 48000;
  const channels = p.audioChannels > 0 ? Math.min(2, p.audioChannels) : 2;
  return [
    '-vf', `scale=${p.width}:${p.height},format=${p.pixFmt || 'yuv420p'}`,
    '-c:v', 'libx264', '-profile:v', profile, '-preset', 'medium', '-crf', '18',
    '-x264-params', `keyint=${Math.round(fps * 2)}:min-keyint=${Math.round(fps)}`, '-r', String(fps), '-video_track_timescale', '90000',
    '-c:a', 'aac', '-b:a', '128k', '-ar', String(rate), '-ac', String(channels),
  ];
}

export interface AssembleInput {
  /** The master on disk. */
  masterPath: string;
  /** Trim in seconds; null means from the start / to the end. */
  trimIn: number | null;
  trimOut: number | null;
  /** The card PNG to put in front, or null for no pre-roll. */
  cardPng: Buffer | null;
  bedPath: string;
  outPath: string;
}

export interface AssembleResult {
  durationSeconds: number;
  /** The join had to be re-encoded because the stream copy did not verify. */
  reencoded: boolean;
  trimmed: boolean;
  prerolled: boolean;
}

/**
 * Trim and prepend. A trim alone is one stream-copy pass; a card alone is a
 * concat; both is a trim to a temp file then a concat.
 */
export async function assemble(input: AssembleInput): Promise<AssembleResult> {
  const src = await probe(input.masterPath);
  const trimIn = input.trimIn != null && input.trimIn > 0.05 ? input.trimIn : null;
  const trimOut = input.trimOut != null && input.trimOut < src.durationSeconds - 0.05 ? input.trimOut : null;
  const trimmed = trimIn != null || trimOut != null;
  const d = await mkdtemp(join(tmpdir(), 'studio-assemble-'));
  try {
    let body = input.masterPath;
    if (trimmed) {
      body = join(d, 'body.mp4');
      // -ss before -i seeks to the keyframe at or before the point; with
      // stream copy the cut lands on that keyframe, within a second of the
      // asked time, which is what the editor was told to expect.
      await ffmpeg([
        ...(trimIn != null ? ['-ss', tsArg(trimIn)] : []),
        '-i', input.masterPath,
        ...(trimOut != null ? ['-to', tsArg(trimOut - (trimIn ?? 0))] : []),
        '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', body,
      ]);
    }
    if (!input.cardPng) {
      if (!trimmed) throw new Error('nothing to assemble');
      await ffmpeg(['-i', body, '-c', 'copy', '-movflags', '+faststart', input.outPath]);
      const out = await probe(input.outPath);
      return { durationSeconds: out.durationSeconds, reencoded: false, trimmed, prerolled: false };
    }

    const png = join(d, 'card.png');
    await writeFile(png, input.cardPng);
    const card = join(d, 'card.mp4');
    await ffmpeg([
      '-loop', '1', '-framerate', String(src.fps > 0 ? src.fps : 25), '-i', png, '-i', input.bedPath,
      '-t', String(CARD_SECONDS), ...matchArgs(src), '-af', 'apad', '-shortest', '-movflags', '+faststart', card,
    ]);
    const list = join(d, 'concat.txt');
    // Paths are the worker's own temp files; the quoting is for the demuxer's parser.
    await writeFile(list, `file '${card.replace(/'/g, "'\\''")}'\nfile '${body.replace(/'/g, "'\\''")}'\n`);
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', input.outPath]);
    const bodyDur = trimmed ? (await probe(body)).durationSeconds : src.durationSeconds;
    const out = await probe(input.outPath);
    if (Math.abs(out.durationSeconds - bodyDur - CARD_SECONDS) < 0.5) {
      return { durationSeconds: out.durationSeconds, reencoded: false, trimmed, prerolled: true };
    }
    // The stream copy did not line up: re-encode the join. Slow, but right.
    await ffmpeg([
      '-f', 'concat', '-safe', '0', '-i', list, ...matchArgs(src), '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', input.outPath,
    ]);
    const re = await probe(input.outPath);
    return { durationSeconds: re.durationSeconds, reencoded: true, trimmed, prerolled: true };
  } finally {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
}
