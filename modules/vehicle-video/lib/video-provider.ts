/**
 * Video-provider seam. The clip step calls submitClip / awaitClip / downloadClip
 * here; this module dispatches to the configured engine and keeps Veo as a
 * fallback. Switch with VEHICLE_VIDEO_VIDEO_PROVIDER = kling | veo (default veo;
 * kling requires FAL_KEY). Handles are tagged with the provider so a resumed job
 * routes back to the right engine.
 *
 * The clip PROMPT is authored in the vehicle-video-clip-prompt skill; this file
 * only makes the media call. The shared anti-drift negative prompt lives here so
 * every provider gets the same fidelity guardrail.
 */

import { submitClip as veoSubmit, awaitClip as veoAwait, downloadClip as veoDownload } from './veo.js';
import { klingSubmit, klingAwait, klingDownload } from './kling.js';

export type ProviderName = 'veo' | 'kling';

export function activeProvider(): ProviderName {
  // Kling is the proven engine (exact car under motion); Veo stays as a fallback
  // only when explicitly selected.
  return (process.env.VEHICLE_VIDEO_VIDEO_PROVIDER ?? 'kling').trim().toLowerCase() === 'veo' ? 'veo' : 'kling';
}

/** Nominal clip length for the active provider (Kling emits 5s; Veo 8s). */
export function clipDurationSeconds(): number {
  return activeProvider() === 'kling' ? 5 : 8;
}

// Applied to every provider — the clip must animate the EXACT car in the photo and
// never invent a different vehicle, flip the steering-wheel side, or regenerate
// un-photographed areas (cars are the hard case: models love to "improve" wheels,
// badges, ride height, lights).
const DEFAULT_NEGATIVE =
  'a different car, different vehicle, different model, wrong car, replaced car, changed colour, ' +
  'changed interior, regenerated interior, different dashboard, left-hand drive, LHD, ' +
  'steering wheel on the left, steering wheel moving to the other side, mirror-flipped, ' +
  'morphing, warping bodywork, distorted panels, floating car, extra doors, extra wheels, different wheels, ' +
  'different alloys, changed wheel design, invented badges, altered ride height, reshaped headlights, ' +
  // Kling loves to add sporty red calipers and to drift the number plate / drive in reverse.
  'red brake calipers, coloured brake calipers, painted calipers, changed number plate, altered registration, ' +
  'wrong number plate, reversing, driving backwards, wheels spinning backwards, ' +
  'added text, watermark, caption, logo overlay, number plate change, ' +
  'inventing parts not visible in the photo, hallucinated details, ' +
  // Camera must be smooth and steady — no handheld bounce.
  'camera shake, shaky camera, bouncing camera, handheld wobble, jerky motion, ' +
  'fast motion, jump cut, scene change, cartoon, 3d render';

export interface SubmitInput {
  imageBase64: string;
  imageMimeType: string;
  prompt: string;
  negativePrompt?: string;
  /** Hosted fal URLs of extra reference angles (front/side/rear) to keep the car
   *  accurate — number plate, colour, wheels. Kling `elements` (max 3). Veo ignores. */
  referenceImageUrls?: string[];
}

function splitHandle(handle: string): [ProviderName, string] {
  const i = handle.indexOf(':');
  if (i < 0) return ['veo', handle]; // legacy bare Veo operation names
  const p = handle.slice(0, i);
  if (p === 'veo' || p === 'kling') return [p, handle.slice(i + 1)];
  return ['veo', handle];
}

/** Submit one still + prompt to the active provider. Returns a tagged handle. */
export async function submitClip(input: SubmitInput): Promise<string> {
  const negativePrompt = [DEFAULT_NEGATIVE, input.negativePrompt].filter(Boolean).join(', ');
  if (activeProvider() === 'kling') {
    const id = await klingSubmit({ ...input, negativePrompt, durationSeconds: clipDurationSeconds() });
    return `kling:${id}`;
  }
  const op = await veoSubmit({ ...input, negativePrompt });
  return `veo:${op}`;
}

/** Poll a tagged handle to completion. Returns a tagged result URL/URI. */
export async function awaitClip(handle: string): Promise<string> {
  const [provider, token] = splitHandle(handle);
  if (provider === 'kling') return `kling:${await klingAwait(token)}`;
  return `veo:${await veoAwait(token)}`;
}

/** Download a tagged result URL/URI produced by awaitClip. */
export async function downloadClip(tagged: string): Promise<Buffer> {
  const [provider, url] = splitHandle(tagged);
  if (provider === 'kling') return klingDownload(url);
  return veoDownload(url);
}
