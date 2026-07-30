/**
 * Google Veo client via the Gemini API path (generativelanguage.googleapis.com).
 * Uses the same Google AI key as Gemini image/TTS — not a separate Veo domain
 * (spec §8/§10.5). Image-to-video: submit one still + a prompt → poll the
 * operation via REST → download the clip through the authenticated proxy (Veo
 * URIs 403 without the key). SDK operations.get() can't cross a stateless
 * boundary, so we call REST directly (idea Appendix B).
 */

import { requireGoogleKey } from './google-key.js';
import { VehicleVideoError } from './errors.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const POLL_INTERVAL_MS = 8_000;
const POLL_TIMEOUT_MS = 8 * 60_000;

function veoModel(): string {
  const tier = (process.env.VEHICLE_VIDEO_VEO_MODEL ?? 'fast') === 'standard' ? 'standard' : 'fast';
  return tier === 'standard' ? 'veo-3.1-generate-preview' : 'veo-3.1-fast-generate-preview';
}

/** Submit one image + prompt to Veo; returns the operation name for polling.
 *  The shared anti-drift negative prompt is composed by the video-provider seam
 *  and passed in via `negativePrompt`. */
export async function submitClip(input: {
  imageBase64: string;
  imageMimeType: string;
  prompt: string;
  negativePrompt?: string;
}): Promise<string> {
  const key = requireGoogleKey();
  const model = veoModel();
  const url = `${API_BASE}/models/${model}:predictLongRunning?key=${encodeURIComponent(key)}`;
  const negativePrompt = input.negativePrompt ?? '';
  const body = {
    instances: [
      {
        prompt: input.prompt,
        image: { bytesBase64Encoded: input.imageBase64, mimeType: input.imageMimeType },
      },
    ],
    parameters: {
      aspectRatio: '16:9',
      durationSeconds: 8,
      // NOTE: this Veo model rejects a `generateAudio` param, so we don't send it
      // (we overlay our own TTS voiceover and ignore Veo's soundtrack).
      negativePrompt,
    },
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', `submit network error: ${(err as Error).message}`);
  }
  if (res.status === 404) {
    throw new VehicleVideoError('VEO_MODEL_UNAVAILABLE', 'clip', `Veo model ${model} unavailable for this key (404)`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', `submit HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { name?: string };
  if (!json.name) throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', 'submit returned no operation name');
  return json.name;
}

function extractVideoUri(result: Record<string, unknown>): string | null {
  // Nesting varies across Veo responses (idea Appendix B).
  const response = result.response as Record<string, unknown> | undefined;
  const gvr = response?.generateVideoResponse as Record<string, unknown> | undefined;
  const samples =
    (gvr?.generatedSamples as Array<Record<string, unknown>> | undefined) ??
    (response?.generatedVideos as Array<Record<string, unknown>> | undefined) ??
    [];
  const first = samples[0];
  if (!first) return null;
  const video = first.video as Record<string, unknown> | undefined;
  return (video?.uri as string) ?? (first.uri as string) ?? null;
}

/** Poll the operation once. Returns { done, videoUri? }. */
export async function pollOperation(operationName: string): Promise<{ done: boolean; videoUri?: string }> {
  const key = requireGoogleKey();
  const url = `${API_BASE}/${operationName}?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', `poll HTTP ${res.status}`);
  }
  const result = (await res.json()) as Record<string, unknown>;
  if (!result.done) return { done: false };
  if (result.error) {
    throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', `Veo operation error: ${JSON.stringify(result.error).slice(0, 200)}`);
  }
  const videoUri = extractVideoUri(result);
  return { done: true, ...(videoUri ? { videoUri } : {}) };
}

/** Poll to completion (bounded by POLL_TIMEOUT_MS); returns the video URI. */
export async function awaitClip(operationName: string): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const { done, videoUri } = await pollOperation(operationName);
    if (done) {
      if (!videoUri) throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', 'Veo done but no video URI');
      return videoUri;
    }
    if (Date.now() > deadline) {
      throw new VehicleVideoError('VEO_POLL_TIMEOUT', 'clip', `Veo did not complete within ${POLL_TIMEOUT_MS / 1000}s`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

/** Download the finished clip; the Veo URI 403s without the API key appended. */
export async function downloadClip(videoUri: string): Promise<Buffer> {
  const key = requireGoogleKey();
  // Only proxy Google's own host (§10.5).
  const host = (() => {
    try {
      return new URL(videoUri).hostname;
    } catch {
      return '';
    }
  })();
  if (!host.endsWith('generativelanguage.googleapis.com')) {
    throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', `refusing to download non-Google video URI host: ${host}`);
  }
  const sep = videoUri.includes('?') ? '&' : '?';
  const res = await fetch(`${videoUri}${sep}key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', `clip download HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
