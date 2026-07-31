/**
 * Kling image-to-video via fal.ai — the high-fidelity clip provider. Kling holds
 * the EXACT car far better than Veo (it resists the wheel/badge/ride-height
 * "improvements" Veo makes), so it's the default when a FAL_KEY is configured.
 *
 * fal queue REST: POST the model → { request_id } → poll .../requests/<id>/status
 * → GET .../requests/<id> for the result { video: { url } } → download the clip.
 * The source still is passed inline as a data URI (no separate upload step).
 *
 * Auth: FAL_KEY (fal.ai). Same submit/await/download shape as lib/veo so the
 * video-provider seam can dispatch to either.
 */

import { VehicleVideoError } from './errors.js';

const FAL_QUEUE = 'https://queue.fal.run';
// Overridable so we can move to a newer Kling revision without a code change.
const MODEL = process.env.VEHICLE_VIDEO_KLING_MODEL ?? 'fal-ai/kling-video/v3/pro/image-to-video';
// fal's queue status/result routes key on the first two path segments (the app
// family), e.g. fal-ai/kling-video — derive it so it tracks MODEL.
const MODEL_BASE = MODEL.split('/').slice(0, 2).join('/');
const POLL_INTERVAL_MS = 8_000;
const POLL_TIMEOUT_MS = 12 * 60_000;

function falKey(): string {
  const k = process.env.FAL_KEY ?? process.env.FAL_API_KEY;
  if (!k) throw new VehicleVideoError('VEO_MODEL_UNAVAILABLE', 'clip', 'FAL_KEY is not set — cannot use the Kling video provider');
  return k;
}

/**
 * Upload a still to fal storage and return its hosted URL. Kling REJECTS inline
 * data URIs for the source frame (the worker validates them as empty), so the
 * frame must be hosted first.
 */
export async function falUpload(buffer: Buffer, mimeType: string): Promise<string> {
  const key = falKey();
  const ext = mimeType.includes('png') ? 'png' : 'jpg';
  let init: Response;
  try {
    init = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3', {
      method: 'POST',
      headers: { authorization: `Key ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content_type: mimeType, file_name: `frame.${ext}` }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', `fal upload initiate error: ${(err as Error).message}`);
  }
  if (!init.ok) throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', `fal upload initiate HTTP ${init.status}`);
  const { upload_url, file_url } = (await init.json()) as { upload_url: string; file_url: string };
  const put = await fetch(upload_url, { method: 'PUT', headers: { 'content-type': mimeType }, body: buffer, signal: AbortSignal.timeout(60_000) });
  if (!put.ok) throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', `fal upload PUT HTTP ${put.status}`);
  return file_url;
}

export interface KlingSubmitInput {
  imageBase64: string;
  imageMimeType: string;
  prompt: string;
  negativePrompt?: string;
  durationSeconds?: number;
  /** Extra hosted reference frames (other angles) to keep the car accurate on
   *  wide moves like the stadium orbit — Kling v3 `elements.reference_image_urls`. */
  referenceImageUrls?: string[];
}

/** Submit one still + prompt to Kling; returns the fal request_id. */
export async function klingSubmit(input: KlingSubmitInput): Promise<string> {
  const key = falKey();
  // Kling accepts discrete durations; map to its nearest supported (5 or 10).
  const duration = (input.durationSeconds ?? 5) >= 10 ? '10' : '5';
  const imageUrl = await falUpload(Buffer.from(input.imageBase64, 'base64'), input.imageMimeType);
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    image_url: imageUrl,
    duration,
    negative_prompt: input.negativePrompt ?? '',
    // No native soundtrack — we never use Kling's audio and it costs more.
    generate_audio: false,
  };
  if (input.referenceImageUrls && input.referenceImageUrls.length) {
    // Kling's elements block requires a frontal_image_url alongside the references
    // (omitting it 422s); use the first reference (resolved front angle first).
    body.elements = [{ reference_image_urls: input.referenceImageUrls, frontal_image_url: input.referenceImageUrls[0] }];
  }
  let res: Response;
  try {
    res = await fetch(`${FAL_QUEUE}/${MODEL}`, {
      method: 'POST',
      headers: { authorization: `Key ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', `Kling submit network error: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', `Kling submit HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = (await res.json()) as { request_id?: string };
  if (!j.request_id) throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', 'Kling submit returned no request_id');
  return j.request_id;
}

/** Poll a fal request to completion; returns the finished clip's URL. */
export async function klingAwait(requestId: string): Promise<string> {
  const key = falKey();
  const headers = { authorization: `Key ${key}` };
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const st = await fetch(`${FAL_QUEUE}/${MODEL_BASE}/requests/${requestId}/status`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!st.ok) throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', `Kling status HTTP ${st.status}`);
    const sj = (await st.json()) as { status?: string; error?: unknown };
    if (sj.status === 'COMPLETED') break;
    if (sj.status === 'FAILED' || sj.error) {
      throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', `Kling job failed: ${JSON.stringify(sj).slice(0, 200)}`);
    }
    if (Date.now() > deadline) throw new VehicleVideoError('VEO_POLL_TIMEOUT', 'clip', 'Kling did not complete in time');
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  const rr = await fetch(`${FAL_QUEUE}/${MODEL_BASE}/requests/${requestId}`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!rr.ok) throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', `Kling result HTTP ${rr.status}`);
  const rj = (await rr.json()) as { video?: { url?: string }; video_url?: string };
  const url = rj?.video?.url ?? rj?.video_url;
  if (!url) throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', 'Kling result had no video url');
  return url;
}

/** Download the finished Kling clip. Only fal-hosted result URLs are allowed. */
export async function klingDownload(url: string): Promise<Buffer> {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  const falHosted = host === 'fal.media' || host.endsWith('.fal.media') || host.endsWith('.fal.run') || host.endsWith('.fal.ai');
  if (!falHosted) throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', `refusing to download non-fal video host: ${host}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new VehicleVideoError('VEO_SUBMIT_FAILED', 'clip', `Kling download HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
