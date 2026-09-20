/**
 * Photo-booth generation provider.
 *
 * Runs on hosted GPUs because the models that produce a convincing
 * result are orders of magnitude too heavy for a phone browser.
 *
 * fal is the primary provider, chosen after testing both it and
 * Replicate against real photos on 2026-09-20:
 *
 *   - Replicate rejects bursts with 429 at the account level. Six
 *     effects submitted one after another still tripped it, which on a
 *     wedding day — dozens of guests, one account — is the failure mode
 *     that matters. fal queues instead of rejecting.
 *   - fal's edit model preserves identity well enough to skip the
 *     restyle-then-swap-the-real-face-back chain Replicate needed, so a
 *     style is one call (~13 s) rather than two (~25-50 s).
 *
 * Replicate remains supported for the swap effects so a deployment that
 * only has a Replicate token keeps working; see `face-swap.ts`.
 *
 * Configure with:
 *   BOOTH_PROVIDER=fal
 *   FAL_API_KEY=<key>
 *   BOOTH_STYLE_MODEL=<model>   (optional override)
 *   BOOTH_SWAP_MODEL=<model>    (optional override)
 *
 * Absent by default: with nothing configured the booth reports
 * unavailable and the guest UI never offers it. Nothing on the ordinary
 * upload path depends on any of this.
 */

import { faceSwapConfigured, faceSwapStatus, runFaceSwap } from './face-swap.js';

export type BoothResult =
  | { ok: true; image: Uint8Array; contentType: string }
  | { ok: false; error: 'not_configured' | 'provider_error' | 'no_face' | 'timeout'; detail?: string };

const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** A generated image far larger than this means something is wrong. */
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

const DEFAULT_STYLE_MODEL = 'fal-ai/nano-banana/edit';
const DEFAULT_SWAP_MODEL = 'fal-ai/face-swap';
const DEFAULT_DEPTH_MODEL = 'fal-ai/image-preprocessors/depth-anything/v2';

/**
 * fal model slugs reach the request URL, so they are constrained to the
 * shape fal actually uses rather than trusted from the environment.
 */
const MODEL_RE = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9._-]*){1,3}$/;

function falKey(): string | null {
  const key = process.env.FAL_API_KEY ?? '';
  return key.trim() ? key.trim() : null;
}

function falEnabled(): boolean {
  const provider = (process.env.BOOTH_PROVIDER ?? '').toLowerCase();
  return provider === 'fal' && falKey() !== null;
}

function model(envVar: string, fallback: string): string {
  const raw = (process.env[envVar] ?? '').trim();
  return raw && MODEL_RE.test(raw) ? raw : fallback;
}

/** Styles need fal; swaps can run on either provider. */
export function styleConfigured(): boolean {
  return falEnabled();
}

export function swapConfigured(): boolean {
  return falEnabled() || faceSwapConfigured();
}

export function boothConfigured(): boolean {
  return styleConfigured() || swapConfigured();
}

/** Why each half of the booth is on or off, for the admin panel. */
export function boothStatus(): {
  configured: boolean;
  reason?: string;
  styles: boolean;
  swaps: boolean;
} {
  const styles = styleConfigured();
  const swaps = swapConfigured();
  if (styles || swaps) return { configured: true, styles, swaps };

  const provider = (process.env.BOOTH_PROVIDER ?? '').toLowerCase();
  let reason: string;
  if (!provider) {
    // Mention the legacy path only when it is the one half-configured.
    const legacy = faceSwapStatus();
    reason = legacy.reason && process.env.FACE_SWAP_PROVIDER
      ? `BOOTH_PROVIDER is not set (and ${legacy.reason})`
      : 'BOOTH_PROVIDER is not set';
  } else if (provider !== 'fal') {
    reason = `unknown provider "${provider}"`;
  } else {
    reason = 'FAL_API_KEY is not set';
  }
  return { configured: false, reason, styles, swaps };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

interface FalQueued {
  status_url?: string;
  response_url?: string;
  detail?: unknown;
}

interface FalImage {
  url?: unknown;
}

/** fal returns either `images: [...]` or a single `image`. */
function outputUrl(res: Record<string, unknown>): string {
  const images = res['images'];
  const first = Array.isArray(images) ? (images[0] as FalImage | undefined) : undefined;
  const single = res['image'] as FalImage | undefined;
  const url = first?.url ?? single?.url;
  return typeof url === 'string' ? url : '';
}

/**
 * Submit to fal's queue, wait for it, and download the result.
 *
 * `input` is built entirely from our own catalogue and our own storage
 * URLs — no guest-supplied string reaches it.
 */
async function runFal(modelSlug: string, input: Record<string, unknown>): Promise<BoothResult> {
  const key = falKey();
  if (!key) return { ok: false, error: 'not_configured' };
  const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };

  try {
    const submit = await withTimeout(
      fetch(`https://queue.fal.run/${modelSlug}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      }),
      SUBMIT_TIMEOUT_MS,
    );
    if (!submit.ok) {
      const detail = (await submit.text().catch(() => '')).slice(0, 300);
      return { ok: false, error: 'provider_error', detail: `${submit.status} ${detail}` };
    }

    const queued = await submit.json() as FalQueued;
    if (!queued.status_url || !queued.response_url) {
      return { ok: false, error: 'provider_error', detail: 'no queue urls' };
    }
    // fal hands back absolute URLs on its own host; refuse anything else
    // rather than following a redirect off-domain.
    if (!queued.status_url.startsWith('https://queue.fal.run/') ||
        !queued.response_url.startsWith('https://queue.fal.run/')) {
      return { ok: false, error: 'provider_error', detail: 'unexpected queue host' };
    }

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let done = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const poll = await withTimeout(fetch(queued.status_url, { headers }), SUBMIT_TIMEOUT_MS);
      if (!poll.ok) continue;
      const state = await poll.json() as { status?: string };
      if (state.status === 'COMPLETED') { done = true; break; }
      if (state.status !== 'IN_QUEUE' && state.status !== 'IN_PROGRESS') {
        return { ok: false, error: 'provider_error', detail: String(state.status ?? 'unknown') };
      }
    }
    if (!done) return { ok: false, error: 'timeout' };

    const resp = await withTimeout(fetch(queued.response_url, { headers }), SUBMIT_TIMEOUT_MS);
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => '')).slice(0, 300);
      return { ok: false, error: 'provider_error', detail: `result ${resp.status} ${detail}` };
    }
    const result = await resp.json() as Record<string, unknown>;
    // Pin the output host too. This URL comes from fal's own
    // authenticated response rather than from a guest, so it is not an
    // SSRF guests can reach — but a fetch driven by a remote JSON field
    // should not be able to point anywhere it likes.
    const url = outputUrl(result);
    if (!/^https:\/\/([a-z0-9-]+\.)*fal\.(run|media|ai)\//.test(url)) {
      return { ok: false, error: 'provider_error', detail: 'no usable output image' };
    }

    const img = await withTimeout(fetch(url), DOWNLOAD_TIMEOUT_MS);
    if (!img.ok) return { ok: false, error: 'provider_error', detail: `fetch output ${img.status}` };
    const contentType = (img.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim();
    if (!contentType.startsWith('image/')) {
      return { ok: false, error: 'provider_error', detail: `unexpected type ${contentType}` };
    }
    const buf = new Uint8Array(await img.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_OUTPUT_BYTES) {
      return { ok: false, error: 'provider_error', detail: `output ${buf.length} bytes` };
    }
    return { ok: true, image: buf, contentType };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg === 'timeout' ? 'timeout' : 'provider_error', detail: msg.slice(0, 200) };
  }
}

/**
 * Monocular depth map for a photo, near = white.
 *
 * Depth is a property of the PHOTO, not of the viewing session, so it
 * is computed once here and cached alongside the image. The previous
 * approach ran the model in every projector browser, on the main
 * thread, for every photo in the library — which froze the display for
 * seconds at a time (p95 frame gap 3.9 s, measured 2026-09-20). Doing
 * it once, server-side, costs pennies and leaves the projector with
 * nothing to do but sample a texture.
 */
export async function runDepth(imageUrl: string): Promise<BoothResult> {
  if (!falEnabled()) return { ok: false, error: 'not_configured' };
  return runFal(model('BOOTH_DEPTH_MODEL', DEFAULT_DEPTH_MODEL), { image_url: imageUrl });
}

/** Restyle `imageUrl` with a catalogue prompt, keeping the faces. */
export async function runStyle(imageUrl: string, prompt: string): Promise<BoothResult> {
  if (!styleConfigured()) return { ok: false, error: 'not_configured' };
  return runFal(model('BOOTH_STYLE_MODEL', DEFAULT_STYLE_MODEL), {
    prompt,
    image_urls: [imageUrl],
    output_format: 'jpeg',
  });
}

/**
 * Put the face from `faceUrl` onto `targetUrl` (the guest's photo).
 * Prefers fal; falls back to a configured Replicate model.
 */
export async function runSwap(faceUrl: string, targetUrl: string): Promise<BoothResult> {
  if (falEnabled()) {
    const result = await runFal(model('BOOTH_SWAP_MODEL', DEFAULT_SWAP_MODEL), {
      base_image_url: targetUrl,
      swap_image_url: faceUrl,
    });
    // Only reach for the fallback when fal could not answer at all —
    // a "no face in that photo" verdict will not change on retry.
    if (result.ok || result.error === 'no_face' || !faceSwapConfigured()) return result;
  }
  return runFaceSwap(faceUrl, targetUrl);
}
