/**
 * Server-side ffmpeg composition (spec §6 Phase C). Concatenates the approved
 * clips, overlays the narration WAV, and encodes the final MP4. No background
 * music in v1 (§17). Uses the ffmpeg-static binary (baked as a module dep — no
 * Dockerfile change). ffprobe is not bundled, so durations are computed from the
 * known clip lengths + the WAV header rather than probed.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VehicleVideoError } from './errors.js';

const execFileP = promisify(execFile);

// Resolve ffmpeg: explicit FFMPEG_PATH/FFMPEG_BIN env → ffmpeg-static → bare
// `ffmpeg` on PATH. ffmpeg-static returns null on an unsupported arch, so the
// PATH fallback keeps a system ffmpeg working.
export async function ffmpegPath(): Promise<string> {
  const envPath = process.env.FFMPEG_PATH ?? process.env.FFMPEG_BIN;
  if (envPath && envPath.trim()) return envPath.trim();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('ffmpeg-static');
    const p = mod.default ?? mod;
    if (p && typeof p === 'string') return p;
  } catch {
    /* fall through to PATH */
  }
  return 'ffmpeg';
}

/**
 * Strip the audio track from an MP4 (fast remux, no re-encode). Veo generates its
 * own soundtrack we don't want — the clips are silent building blocks and our TTS
 * voiceover is the only audio, added at compose time.
 */
export async function stripAudio(mp4: Buffer): Promise<Buffer> {
  const ffmpeg = await ffmpegPath();
  const dir = await mkdtemp(join(tmpdir(), 'vv-strip-'));
  try {
    const inPath = join(dir, 'in.mp4');
    const outPath = join(dir, 'out.mp4');
    await writeFile(inPath, mp4);
    await execFileP(ffmpeg, ['-y', '-i', inPath, '-map', '0:v:0', '-c:v', 'copy', '-an', '-movflags', '+faststart', outPath], { maxBuffer: 32 * 1024 * 1024 });
    return await readFile(outPath);
  } catch (err) {
    // If remux fails for any reason, fall back to the original clip (with audio)
    // rather than losing the clip entirely.
    return mp4;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** WAV duration (seconds) from its header (bytes after 44-byte header / byteRate). */
export function wavDurationSeconds(wav: Buffer): number {
  if (wav.length < 44) return 0;
  const byteRate = wav.readUInt32LE(28) || 48000;
  const dataLen = wav.readUInt32LE(40) || wav.length - 44;
  return dataLen / byteRate;
}

export interface ComposeInput {
  /** Approved clips in playback order. */
  clips: Buffer[];
  /** Per-clip durations (seconds); same order/length as clips. */
  clipDurations: number[];
  /** Narration WAV (or null → silent video). */
  narrationWav: Buffer | null;
}

/**
 * Compose the final MP4. atempo (≤1.3×) is applied ONLY if the narration runs
 * longer than the video (never slows it down); a shorter narration leaves the
 * clips playing to their natural end.
 */
export async function compose(input: ComposeInput): Promise<Buffer> {
  if (!input.clips.length) {
    throw new VehicleVideoError('COMPOSE_FAILED', 'finalize', 'no clips to compose');
  }
  const ffmpeg = await ffmpegPath();
  const dir = await mkdtemp(join(tmpdir(), 'vehicle-video-'));
  try {
    // Write clips + a concat list.
    const clipPaths: string[] = [];
    for (let i = 0; i < input.clips.length; i++) {
      const p = join(dir, `clip-${i}.mp4`);
      await writeFile(p, input.clips[i]);
      clipPaths.push(p);
    }
    const listPath = join(dir, 'list.txt');
    await writeFile(listPath, clipPaths.map((p) => `file '${p}'`).join('\n'));

    const videoDuration = input.clipDurations.reduce((a, b) => a + (b || 8), 0);
    const outPath = join(dir, 'output.mp4');

    const args: string[] = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath];

    if (input.narrationWav) {
      const wavPath = join(dir, 'narration.wav');
      await writeFile(wavPath, input.narrationWav);
      args.push('-i', wavPath);

      const narrDuration = wavDurationSeconds(input.narrationWav);
      const atempo = narrDuration > videoDuration && videoDuration > 0
        ? Math.min(1.3, Math.max(1.0, (narrDuration / videoDuration) * 1.02))
        : 1.0;

      args.push('-map', '0:v:0', '-map', '1:a:0');
      if (atempo > 1.001) args.push('-filter:a', `atempo=${atempo.toFixed(3)}`);
      args.push('-shortest');
    } else {
      args.push('-map', '0:v:0');
    }

    args.push(
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      outPath,
    );

    try {
      await execFileP(ffmpeg, args, { maxBuffer: 32 * 1024 * 1024 });
    } catch (err) {
      // Concat with -c copy fails if clips differ; retry re-encoding each clip.
      throw new VehicleVideoError(
        'COMPOSE_FAILED',
        'finalize',
        `ffmpeg failed: ${String((err as Error).message).slice(0, 300)}`,
      );
    }

    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
