/**
 * ffmpeg, the way the studio uses it.
 *
 * The binary comes from `ffmpeg-static`, baked into the worker image as a
 * module dependency the same way vehicle-video gets it; FFMPEG_PATH overrides
 * for an operator who wants the system one. There is no ffprobe anywhere, so
 * the stream parameters are read from ffmpeg's own `-i` report, which is
 * enough for what the studio needs: duration, size, frame rate, codec, pixel
 * format, audio rate and channels.
 *
 * Every call is execFile with an argument array. Nothing here is ever a shell
 * string, and nothing here is formatted from request input: paths are the
 * worker's own temp files and times are numbers that have been through
 * Number() first.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** Output from ffmpeg is capped here; a filter that prints per-frame metadata can be chatty. */
const MAX_TEXT = 32 * 1024 * 1024;

export async function ffmpegPath(): Promise<string> {
  const envPath = process.env.FFMPEG_PATH ?? process.env.FFMPEG_BIN;
  if (envPath && envPath.trim()) return envPath.trim();
  try {
    // The package ships no types; it resolves to a path string at runtime.
    // @ts-ignore
    const mod: any = await import('ffmpeg-static');
    const p = mod.default ?? mod;
    if (p && typeof p === 'string') return p;
  } catch {
    /* fall through to PATH */
  }
  return 'ffmpeg';
}

/**
 * Only local files and pipes may be opened by anything ffmpeg demuxes. An
 * uploaded "mp4" is whatever bytes the editor sent, and a playlist format
 * would otherwise let it reach out over the network from the worker.
 */
const PROTOCOLS = ['-protocol_whitelist', 'file,pipe'];

/** Run ffmpeg with `-y -v error` in front; throws with stderr on failure. */
export async function ffmpeg(args: string[], opts: { timeoutMs?: number } = {}): Promise<void> {
  const bin = await ffmpegPath();
  try {
    await execFileP(bin, ['-hide_banner', '-y', '-v', 'error', ...PROTOCOLS, ...args], {
      maxBuffer: MAX_TEXT,
      timeout: opts.timeoutMs ?? 20 * 60 * 1000,
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`ffmpeg failed: ${String(e.stderr || e.message || err).slice(0, 600)}`);
  }
}

/** Run ffmpeg and return stdout as bytes (for `-f rawvideo -` and friends). */
export async function ffmpegBytes(args: string[], opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<Buffer> {
  const bin = await ffmpegPath();
  try {
    const { stdout } = await execFileP(bin, ['-hide_banner', '-v', 'error', ...PROTOCOLS, ...args], {
      encoding: 'buffer',
      maxBuffer: opts.maxBytes ?? 512 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 20 * 60 * 1000,
    });
    return stdout as unknown as Buffer;
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    throw new Error(`ffmpeg failed: ${String(e.stderr || e.message || err).slice(0, 600)}`);
  }
}

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  /** e.g. 'High', 'Main', or '' when ffmpeg did not say. */
  videoProfile: string;
  pixFmt: string;
  audioCodec: string;
  audioRate: number;
  audioChannels: number;
}

/**
 * Parse the `-i` report. Pure, so the regexes are tested without a binary.
 *
 * The lines look like:
 *   Duration: 00:17:08.12, start: 0.000000, bitrate: 4620 kb/s
 *   Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 4500 kb/s, 25 fps, 25 tbr, 90k tbn (default)
 *   Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)
 */
export function parseProbe(report: string): ProbeResult {
  const out: ProbeResult = {
    durationSeconds: 0, width: 0, height: 0, fps: 0, videoCodec: '', videoProfile: '', pixFmt: '',
    audioCodec: '', audioRate: 0, audioChannels: 0,
  };
  const dur = report.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dur) out.durationSeconds = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);

  // Stream lines only, anchored at the start: a file's own metadata tags
  // are printed earlier in the report and could otherwise spell out a fake
  // stream line. Sizes and rates are capped for the same reason.
  const lines = report.split('\n');
  const video = lines.find((l) => /^\s+Stream #\d+:\d+.*: Video: /.test(l));
  if (video) {
    const m = video.match(/Video: ([a-z0-9]+)(?: \(([A-Za-z0-9 .]+)\))?/);
    if (m) { out.videoCodec = m[1]; out.videoProfile = (m[2] ?? '').trim(); }
    const px = video.match(/,\s*([a-z0-9]+)\(/) ?? video.match(/,\s*(yuv[a-z0-9]+|rgb[a-z0-9]*|gray[a-z0-9]*)\b/);
    if (px) out.pixFmt = px[1];
    const size = video.match(/\b(\d{2,5})x(\d{2,5})\b/);
    if (size) { out.width = Math.min(8192, Number(size[1])); out.height = Math.min(8192, Number(size[2])); }
    const fps = video.match(/([\d.]+)\s*fps/);
    if (fps) out.fps = Math.min(240, Number(fps[1]));
  }
  const audio = lines.find((l) => /^\s+Stream #\d+:\d+.*: Audio: /.test(l));
  if (audio) {
    const m = audio.match(/Audio: ([a-z0-9]+)/);
    if (m) out.audioCodec = m[1];
    const hz = audio.match(/(\d+)\s*Hz/);
    if (hz) out.audioRate = Number(hz[1]);
    if (/\bmono\b/.test(audio)) out.audioChannels = 1;
    else if (/\bstereo\b/.test(audio)) out.audioChannels = 2;
    else {
      const ch = audio.match(/(\d+)\s*channels/);
      if (ch) out.audioChannels = Number(ch[1]);
      else if (/5\.1/.test(audio)) out.audioChannels = 6;
    }
  }
  return out;
}

/** `ffmpeg -i file` exits non-zero (no output requested) but prints the report to stderr. */
export async function probe(path: string): Promise<ProbeResult> {
  const bin = await ffmpegPath();
  let report = '';
  try {
    await execFileP(bin, ['-hide_banner', ...PROTOCOLS, '-i', path], { maxBuffer: MAX_TEXT, timeout: 60_000 });
  } catch (err) {
    report = String((err as { stderr?: string }).stderr ?? '');
  }
  const r = parseProbe(report);
  if (!r.durationSeconds || !r.width) throw new Error(`could not probe ${path.split('/').pop()}: ${report.slice(-300)}`);
  return r;
}

/** Seconds as ffmpeg's `-ss` wants them. Numbers only; never a string from a request. */
export function tsArg(seconds: number): string {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) throw new Error('bad timestamp');
  return s.toFixed(3);
}
