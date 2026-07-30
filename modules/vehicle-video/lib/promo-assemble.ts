// @ts-nocheck — sharp + ffmpeg-static resolved at module-host install time.

/**
 * Promo assembler: takes the generated Kling shots for a theme and cuts them
 * into the finished promo — fast hard cuts, cinematic grade, kinetic captions and
 * the title-card + Auto Trader CTA. Mirrors the prototype exactly (this ffmpeg
 * build has no drawtext, so captions are rendered as PNGs via sharp and overlaid;
 * overlay / concat / eq / colorbalance are available). Output is a silent MP4
 * (music is added downstream / by the operator).
 */

import { promisify } from 'node:util';
import { execFile as _execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegPath } from './compose.js';
import { fillPrompt } from './promo-themes.js';

const execFile = promisify(_execFile);
const W = 1280;
const H = 720;
const NORM = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=30`;

async function sharpMod() {
  const mod = await import('sharp');
  return (mod as any).default ?? mod;
}
const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function wrap(t: string, n: number): string[] {
  const words = t.split(/\s+/); const lines: string[] = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > n) { if (cur) lines.push(cur.trim()); cur = w; } else cur += ' ' + w; }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}

/** Render a full-frame transparent PNG with a bottom caption (+ optional CTA). */
async function renderCaption(headline: string, cta: string): Promise<Buffer> {
  const sharp = await sharpMod();
  const lines = wrap(headline.toUpperCase(), 22);
  const HFS = 64, HLH = 74;
  const blockH = lines.length * HLH + (cta ? 54 : 0) + 60;
  const top = H - blockH - 40;
  const tspans = lines.map((l, i) =>
    `<text x="${W/2}" y="${top + 60 + HLH*(i+1) - 18}" font-family="Arial Black, Arial, sans-serif" font-size="${HFS}" font-weight="900" fill="#ffffff" text-anchor="middle" style="paint-order:stroke;stroke:#000;stroke-width:10px;stroke-linejoin:round;">${esc(l)}</text>`,
  ).join('');
  const ctaSvg = cta
    ? `<text x="${W/2}" y="${top + 60 + HLH*lines.length + 40}" font-family="Arial, sans-serif" font-size="30" font-weight="bold" fill="#ffd400" text-anchor="middle" style="paint-order:stroke;stroke:#000;stroke-width:6px;stroke-linejoin:round;">${esc(cta.toUpperCase())}</text>`
    : '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.72"/></linearGradient></defs>` +
    `<rect x="0" y="${top}" width="${W}" height="${H - top}" fill="url(#g)"/>${tspans}${ctaSvg}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function ff(args: string[]): Promise<void> {
  const bin = await ffmpegPath();
  await execFile(bin, ['-y', ...args], { maxBuffer: 1 << 26 });
}

const X264 = ['-an', '-r', '30', '-vsync', 'cfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high'];

/**
 * Assemble the finished promo.
 * @param shotPaths  map of shotKey -> local mp4 path (generated Kling clips)
 * @param theme      the PromoTheme (edit structure, grade, title card)
 * @param car,plate  for filling any caption placeholders (rare)
 * @returns finished promo MP4 as a Buffer
 */
export async function assemblePromo(
  shotPaths: Record<string, string>,
  theme: { edit: Array<{ shotKey: string; in: number; duration: number; caption?: string }>; grade: string; titleCard: { headline: string; cta: string } },
  car = '',
  plate = '',
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'vv-promo-'));
  try {
    const segs: string[] = [];
    let i = 0;
    for (const seg of theme.edit) {
      const src = shotPaths[seg.shotKey];
      if (!src) continue; // a dropped/failed shot just skips its segments
      const out = join(dir, `s${i}.mp4`);
      if (seg.caption) {
        const capPng = join(dir, `c${i}.png`);
        await writeFile(capPng, await renderCaption(fillPrompt(seg.caption, car, plate), ''));
        await ff([
          '-ss', String(seg.in), '-i', src, '-loop', '1', '-i', capPng,
          '-filter_complex', `[0:v]${NORM},${theme.grade}[v];[1:v]format=rgba,fade=t=in:st=0:d=0.15:alpha=1[c];[v][c]overlay=0:0,format=yuv420p[o]`,
          '-map', '[o]', '-t', String(seg.duration), ...X264, out,
        ]);
      } else {
        await ff(['-ss', String(seg.in), '-i', src, '-t', String(seg.duration), '-vf', `${NORM},${theme.grade},format=yuv420p`, ...X264, out]);
      }
      segs.push(out); i++;
    }
    // Title card — freeze a hero frame from the last available shot + title PNG.
    const heroSrc = shotPaths[theme.edit[theme.edit.length - 1]?.shotKey] ?? Object.values(shotPaths)[0];
    if (heroSrc) {
      const heroJpg = join(dir, 'hero.jpg');
      await ff(['-ss', '8.2', '-i', heroSrc, '-frames:v', '1', heroJpg]);
      const titlePng = join(dir, 'title.png');
      await writeFile(titlePng, await renderCaption(theme.titleCard.headline, theme.titleCard.cta));
      const titleMp4 = join(dir, `s${i}.mp4`);
      await ff([
        '-loop', '1', '-i', heroJpg, '-loop', '1', '-i', titlePng,
        '-filter_complex', `[0:v]${NORM},${theme.grade}[v];[1:v]format=rgba,fade=t=in:st=0:d=0.2:alpha=1[t];[v][t]overlay=0:0,format=yuv420p[o]`,
        '-map', '[o]', '-t', '2.8', ...X264, titleMp4,
      ]);
      segs.push(titleMp4);
    }
    if (!segs.length) throw new Error('no promo segments produced');
    const list = join(dir, 'concat.txt');
    await writeFile(list, segs.map((p) => `file '${p}'`).join('\n'));
    const finalMp4 = join(dir, 'promo.mp4');
    await ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', finalMp4]);
    return readFile(finalMp4);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
