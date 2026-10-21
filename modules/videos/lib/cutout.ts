/**
 * Cut the speaker out of one full-resolution frame.
 *
 * The person comes from birefnet, limited by a prompted EVF-SAM mask of "the
 * person presenting" (dilated) so a flat slide touching the person does not
 * come along; if that intersection drops more than a third of the area the
 * prompted mask missed the head and birefnet alone is kept. Audience heads
 * are subtracted only in the bottom 38% of the frame. The lectern and its
 * microphone are joined only when the vision pass saw a lectern and its
 * bounds overlap the person's by at least 30%. A dark cut-out gets a gamma
 * lift by its mean luma.
 *
 * When the frame is a composite, the work is done on the camera panel crop
 * and the result pasted back at the panel's offset, so the bounds are in
 * frame space and nothing outside the panel can leak in.
 *
 * Everything is ffmpeg on files in one temp dir; the mask arithmetic
 * (blend darken = intersect, lighten = union) is the prototype's.
 */

import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, ffmpegBytes } from './ffmpeg.js';
import { queued, resultImage, dataUri } from './fal.js';
import { alphaBounds, maskArea, maskBounds, meanLuma, gammaFor, glareFraction, screenFraction, type Box } from './studio-pixels.js';

export interface CutoutInput {
  /** The full frame as JPEG bytes. */
  frame: Buffer;
  width: number;
  height: number;
  /** x, y, w, h of the camera panel when the frame is a composite. */
  cameraCrop?: [number, number, number, number] | null;
  /** The vision pass saw a lectern in front of the speaker. */
  lectern?: boolean;
}

export interface CutoutResult {
  /** RGBA PNG at the frame's size. */
  png: Buffer;
  bbox: Box | null;
  meanLuma: number;
  gamma: number;
  lecternJoined: boolean;
  glare: number;
  screen: number;
}

async function rawGray(path: string): Promise<Buffer> {
  return ffmpegBytes(['-i', path, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
}

export async function cutOut(input: CutoutInput): Promise<CutoutResult> {
  const d = await mkdtemp(join(tmpdir(), 'studio-cut-'));
  try {
    const full = join(d, 'full.jpg');
    await writeFile(full, input.frame);
    let src = full; let W = input.width; let H = input.height;
    const cam = input.cameraCrop ?? null;
    if (cam) {
      const [x, y, w, h] = cam;
      src = join(d, 'cam.jpg');
      await ffmpeg(['-i', full, '-vf', `crop=${w}:${h}:${x}:${y}`, '-q:v', '2', src]);
      W = w; H = h;
    }
    const srcBytes = await readFile(src);
    const srcUri = dataUri(srcBytes);

    // Person.
    const person = await resultImage(await queued('fal-ai/birefnet/v2', {
      image_url: srcUri, model: 'General Use (Heavy)', operating_resolution: '2048x2048', output_format: 'png', refine_foreground: true,
    }));
    await writeFile(join(d, 'person.png'), person);
    await ffmpeg(['-i', join(d, 'person.png'), '-vf', `alphaextract,scale=${W}:${H}`, '-pix_fmt', 'gray', join(d, 'm_biref.png')]);

    const evfPerson = await resultImage(await queued('fal-ai/evf-sam', {
      image_url: srcUri, prompt: 'the person presenting, including anything they are holding', mask_only: true,
    }));
    await writeFile(join(d, 'm_evfperson.png'), evfPerson);
    await ffmpeg(['-i', join(d, 'm_evfperson.png'), '-vf', `format=gray,scale=${W}:${H},dilation,dilation,dilation,dilation,dilation,dilation,gblur=sigma=6`, join(d, 'm_evfperson_wide.png')]);
    await ffmpeg(['-i', join(d, 'm_biref.png'), '-i', join(d, 'm_evfperson_wide.png'), '-filter_complex', '[0][1]blend=all_mode=darken,format=gray', join(d, 'm_person_only.png')]);
    const aB = maskArea(await rawGray(join(d, 'm_biref.png')));
    const aI = maskArea(await rawGray(join(d, 'm_person_only.png')));
    let union = aB && aI / aB >= 0.66 ? join(d, 'm_person_only.png') : join(d, 'm_biref.png');

    // Audience, bottom band only.
    const evfAud = await resultImage(await queued('fal-ai/evf-sam', {
      image_url: srcUri, prompt: 'the heads and shoulders of audience members in the foreground, seen from behind', mask_only: true,
    }));
    await writeFile(join(d, 'm_audience.png'), evfAud);
    await ffmpeg(['-i', join(d, 'm_audience.png'), '-vf', `format=gray,scale=${W}:${H},geq=lum='if(gt(Y,${Math.floor(H * 0.62)}),lum(X,Y),0)'`, join(d, 'm_audience_band.png')]);

    // Lectern and mic, when seen and overlapping.
    let lecternJoined = false;
    if (input.lectern) {
      const lect = await resultImage(await queued('fal-ai/evf-sam', {
        image_url: srcUri, prompt: 'the entire lectern including the printed sign board on its front and the microphones on top', mask_only: true,
      }));
      await writeFile(join(d, 'm_lectern_raw.png'), lect);
      await ffmpeg(['-i', join(d, 'm_lectern_raw.png'), '-vf', `format=gray,scale=${W}:${H}`, join(d, 'm_lectern.png')]);
      const mic = await resultImage(await queued('fal-ai/evf-sam', {
        image_url: srcUri, prompt: 'the microphone on the lectern', mask_only: true,
      }));
      await writeFile(join(d, 'm_mic_raw.png'), mic);
      await ffmpeg(['-i', join(d, 'm_mic_raw.png'), '-vf', `format=gray,scale=${W}:${H}`, join(d, 'm_mic.png')]);
      const pb = maskBounds(await rawGray(union), W, H);
      const lb = maskBounds(await rawGray(join(d, 'm_lectern.png')), W, H);
      const overlap = pb && lb ? Math.max(0, Math.min(pb.x1, lb.x1) - Math.max(pb.x0, lb.x0)) / Math.max(1, lb.x1 - lb.x0) : 0;
      if (overlap >= 0.3) {
        await ffmpeg(['-i', join(d, 'm_lectern.png'), '-i', join(d, 'm_mic.png'), '-filter_complex', '[0][1]blend=all_mode=lighten,format=gray', join(d, 'm_obj.png')]);
        await ffmpeg(['-i', union, '-i', join(d, 'm_obj.png'), '-filter_complex', '[0]format=gray[p];[p][1]blend=all_mode=lighten,format=gray', join(d, 'm_union.png')]);
        union = join(d, 'm_union.png');
        lecternJoined = true;
      }
    }

    await ffmpeg(['-i', union, '-i', join(d, 'm_audience_band.png'), '-filter_complex', '[1]negate[na];[0][na]blend=all_mode=darken,format=gray,gblur=sigma=1.0', join(d, 'm_final.png')]);
    await ffmpeg(['-i', src, '-i', join(d, 'm_final.png'), '-filter_complex', '[0][1]alphamerge', join(d, 'speaker_src.png')]);
    if (cam) {
      await ffmpeg(['-f', 'lavfi', '-i', `color=c=black@0:s=${input.width}x${input.height},format=rgba`, '-i', join(d, 'speaker_src.png'),
        '-filter_complex', `[0][1]overlay=${cam[0]}:${cam[1]}:format=auto`, '-frames:v', '1', join(d, 'speaker_raw.png')]);
    } else {
      await ffmpeg(['-i', join(d, 'speaker_src.png'), join(d, 'speaker_raw.png')]);
    }

    // Exposure.
    const raw = await ffmpegBytes(['-i', join(d, 'speaker_raw.png'), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    const mean = meanLuma(raw);
    const gamma = gammaFor(mean);
    const finalPath = join(d, 'speaker.png');
    if (gamma > 1) await ffmpeg(['-i', join(d, 'speaker_raw.png'), '-vf', `eq=gamma=${gamma}:contrast=1.06`, finalPath]);
    else await ffmpeg(['-i', join(d, 'speaker_raw.png'), finalPath]);

    const finalRaw = await ffmpegBytes(['-i', finalPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    const bbox = alphaBounds(finalRaw, input.width, input.height);
    let glare = 1; let screen = 0;
    if (bbox) {
      glare = glareFraction(finalRaw, input.width, bbox);
      const rgb = await ffmpegBytes(['-i', full, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      screen = screenFraction(rgb, finalRaw, input.width, input.height, bbox);
    }
    return { png: await readFile(finalPath), bbox, meanLuma: Math.round(mean), gamma, lecternJoined, glare: Number(glare.toFixed(3)), screen: Number(screen.toFixed(3)) };
  } finally {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
}
