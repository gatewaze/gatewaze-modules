/**
 * Free "Ken Burns" motion preview (no Veo). Simulates the shot's camera move as
 * a pan/zoom over the actual still photo with ffmpeg, so the operator can check
 * framing + pacing + the voiceover for £0 before spending on real Veo clips.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VehicleVideoError } from './errors.js';

const execFileP = promisify(execFile);

const FPS = 25;
const W = 1280;
const H = 720;

type Motion = 'in' | 'out' | 'left' | 'right' | 'up' | 'down';

/** Pick a camera motion from the shot's camera_prompt keywords. */
export function motionFor(cameraPrompt: string | null | undefined): Motion {
  const p = (cameraPrompt ?? '').toLowerCase();
  if (/\b(pull|pulling|zoom out|wide|reveal|pullback|pull back|out to)\b/.test(p)) return 'out';
  if (/\bpan left|left to right|track.*left|slide left\b/.test(p)) return 'right'; // camera moves L→R across the car
  if (/\bpan right|right to left|track.*right|slide right\b/.test(p)) return 'left';
  if (/\b(rise|crane up|tilt up|boom up|from bumper|to roof)\b/.test(p)) return 'up';
  if (/\b(tilt down|crane down|from roof|to bumper)\b/.test(p)) return 'down';
  return 'in'; // default: gentle push in
}

/** Build the zoompan filter for a motion over `frames` output frames. */
function zoompanFilter(motion: Motion, frames: number): string {
  // Oversample the still so there's room to pan/zoom, then zoompan → 1280x720.
  const pre = `scale=2560:1440:force_original_aspect_ratio=increase,crop=2560:1440`;
  const zc = `d=${frames}:s=${W}x${H}:fps=${FPS}`;
  switch (motion) {
    case 'in':
      return `${pre},zoompan=z='min(zoom+0.0012,1.35)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':${zc}`;
    case 'out':
      return `${pre},zoompan=z='if(eq(on,0),1.35,max(zoom-0.0012,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':${zc}`;
    case 'right': // content pans so the car sweeps left→right
      return `${pre},zoompan=z='1.15':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)':${zc}`;
    case 'left':
      return `${pre},zoompan=z='1.15':x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)':${zc}`;
    case 'up':
      return `${pre},zoompan=z='1.15':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-on/${frames})':${zc}`;
    case 'down':
      return `${pre},zoompan=z='1.15':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*on/${frames}':${zc}`;
  }
}

/** Generate one Ken Burns clip (MP4 Buffer) from a still photo. */
export async function kenBurnsClip(
  ffmpeg: string,
  photo: Buffer,
  cameraPrompt: string | null | undefined,
  seconds = 8,
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'vv-preview-'));
  try {
    const inPath = join(dir, 'in.jpg');
    const outPath = join(dir, 'out.mp4');
    await writeFile(inPath, photo);
    const frames = Math.max(1, Math.round(seconds * FPS));
    const vf = zoompanFilter(motionFor(cameraPrompt), frames);
    const args = [
      '-y', '-loop', '1', '-i', inPath, '-t', String(seconds), '-r', String(FPS),
      '-filter_complex', `[0:v]${vf},format=yuv420p[v]`,
      '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
      outPath,
    ];
    await execFileP(ffmpeg, args, { maxBuffer: 16 * 1024 * 1024 });
    return await readFile(outPath);
  } catch (err) {
    throw new VehicleVideoError('COMPOSE_FAILED', 'finalize', `ken-burns failed: ${String((err as Error).message).slice(0, 250)}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
