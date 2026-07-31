/**
 * Dealer logo watermark. The brand config lives in installed_modules.config
 * (module-level — a dealer's logo is the same across videos): { enabled,
 * logo_path, position, scale, opacity }. Applied as a small ffmpeg overlay on
 * the final video and the free preview so operators see it before spending.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegPath } from './compose.js';

const execFileP = promisify(execFile);

export type WatermarkPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface WatermarkConfig {
  enabled: boolean;
  logo_path: string | null;
  position: WatermarkPosition;
  /** Logo width as a fraction of a nominal 1280px-wide frame (0.05–0.30). */
  scale: number;
  /** 0–1. */
  opacity: number;
}

export const DEFAULT_WATERMARK: WatermarkConfig = {
  enabled: false,
  logo_path: null,
  position: 'bottom-right',
  scale: 0.12,
  opacity: 0.9,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supabase = any;

/** Read the module-level watermark config from installed_modules.config. */
export async function resolveWatermark(supabase: Supabase): Promise<WatermarkConfig> {
  try {
    const { data } = await supabase.from('installed_modules').select('config').eq('id', 'vehicle-video').maybeSingle();
    const wm = data?.config?.watermark;
    if (wm && typeof wm === 'object') return { ...DEFAULT_WATERMARK, ...wm };
  } catch {
    /* fall back to default */
  }
  return { ...DEFAULT_WATERMARK };
}

/** Persist the module-level watermark config (merges into installed_modules.config). */
export async function saveWatermark(supabase: Supabase, patch: Partial<WatermarkConfig>): Promise<WatermarkConfig> {
  const { data } = await supabase.from('installed_modules').select('config').eq('id', 'vehicle-video').maybeSingle();
  const config = (data?.config && typeof data.config === 'object' ? data.config : {}) as Record<string, unknown>;
  const current = { ...DEFAULT_WATERMARK, ...(config.watermark as object) };
  const next = { ...current, ...patch };
  await supabase.from('installed_modules').update({ config: { ...config, watermark: next } }).eq('id', 'vehicle-video');
  return next;
}

function overlayXY(position: WatermarkPosition, margin = 24): string {
  switch (position) {
    case 'bottom-left': return `${margin}:main_h-overlay_h-${margin}`;
    case 'top-right': return `main_w-overlay_w-${margin}:${margin}`;
    case 'top-left': return `${margin}:${margin}`;
    case 'bottom-right':
    default: return `main_w-overlay_w-${margin}:main_h-overlay_h-${margin}`;
  }
}

/**
 * Overlay `logo` onto `mp4` as a small watermark (second pass). Keeps audio,
 * re-encodes video. Returns the original video unchanged on any failure (a
 * watermark problem must never lose the video).
 */
export async function applyWatermark(
  mp4: Buffer,
  logo: Buffer,
  cfg: Pick<WatermarkConfig, 'position' | 'scale' | 'opacity'>,
): Promise<Buffer> {
  const ffmpeg = await ffmpegPath();
  const dir = await mkdtemp(join(tmpdir(), 'vv-wm-'));
  try {
    const vidPath = join(dir, 'in.mp4');
    const logoPath = join(dir, 'logo.png');
    const outPath = join(dir, 'out.mp4');
    await writeFile(vidPath, mp4);
    await writeFile(logoPath, logo);

    const logoW = Math.max(48, Math.round(1280 * Math.min(0.3, Math.max(0.05, cfg.scale || 0.12))));
    const opacity = Math.min(1, Math.max(0, cfg.opacity ?? 0.9));
    const filter =
      `[1:v]scale=${logoW}:-1,format=rgba,colorchannelmixer=aa=${opacity.toFixed(2)}[wm];` +
      `[0:v][wm]overlay=${overlayXY(cfg.position)}`;

    await execFileP(ffmpeg, [
      '-y', '-i', vidPath, '-i', logoPath,
      '-filter_complex', filter,
      '-c:a', 'copy', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', outPath,
    ], { maxBuffer: 64 * 1024 * 1024 });
    return await readFile(outPath);
  } catch {
    return mp4; // never lose the video over a watermark failure
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
