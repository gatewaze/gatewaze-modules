/**
 * Relighting a photograph with a model, as the other half of "improve".
 *
 * lib/enhance.ts is arithmetic: every output pixel is a sum of numbers
 * already in the photograph, so nothing can appear that was not there.
 * This is the opposite bargain. ControlLight is a FLUX.2 fine-tune that
 * reconstructs the image, and it will invent -- run over the wedding's
 * night-before album on 2026-09-29 it switched on a picture light above
 * a painting that nobody had lit. It is kept apart from the standard
 * enhancement for exactly that reason, stored under its own key, and
 * shown only where an organiser has asked for it by name.
 *
 * Two things measured on that run shape what is here:
 *
 *   it does not brighten. Five of seven moved by under 8 levels of mean
 *   luma, and the one well-lit photograph in the set was pulled 31
 *   levels DARKER. What it reliably does is deepen the blacks. So it is
 *   not a substitute for the exposure correction, and it is never run
 *   automatically over an album that merely looks dark.
 *
 *   it warms everything. Red rose against green on all seven. The
 *   browser measures that against the original and pulls the colour back
 *   (neutraliseFor in lib/enhance.ts) -- the cast is an artefact of the
 *   model, not a choice anybody made.
 *
 * THE API NEVER DECODES A PHOTOGRAPH here either. This module submits a
 * URL, waits, and downloads bytes; the correcting and re-encoding happen
 * in the organiser's browser, for the reason written at the top of
 * api/enhance-media.ts -- a 512MB pod and two outages.
 */

/** What one call gives back: the bytes, untouched. */
export type AiEnhanceResult =
  | { ok: true; image: Uint8Array; contentType: string }
  | { ok: false; error: string; detail?: string };

const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 2_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** A relit copy far larger than this means something is wrong. */
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

const DEFAULT_MODEL = 'fal-ai/control-light';

/**
 * Model slugs reach the request URL, so they are constrained to the
 * shape fal uses rather than trusted from the environment.
 */
const MODEL_RE = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9._-]*){1,3}$/;

/**
 * How much of the model's effect to apply, 0..1. Its own default is
 * 0.75, which is what the 2026-09-29 comparison was run at.
 */
const DEFAULT_STRENGTH = 0.75;

function falKey(): string | null {
  const key = process.env['FAL_API_KEY'] ?? '';
  return key.trim() ? key.trim() : null;
}

function modelSlug(): string {
  const raw = (process.env['EVENT_MEDIA_AI_ENHANCE_MODEL'] ?? '').trim();
  return raw && MODEL_RE.test(raw) ? raw : DEFAULT_MODEL;
}

/** Whether an organiser can ask for this at all. */
export function aiEnhanceConfigured(): boolean {
  return falKey() !== null;
}

/** The strength one run uses, clamped whatever the environment says. */
export function strengthFor(asked?: unknown): number {
  const n = typeof asked === 'number' ? asked : Number(asked);
  if (!Number.isFinite(n)) return DEFAULT_STRENGTH;
  return Number(Math.max(0.1, Math.min(1, n)).toFixed(2));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

interface FalQueued { status_url?: string; response_url?: string }
interface FalImage { url?: string }

/** fal returns either `images: [...]` or a single `image`. */
function outputUrl(res: Record<string, unknown>): string {
  const images = res['images'];
  const first = Array.isArray(images) ? (images[0] as FalImage | undefined) : undefined;
  const single = res['image'] as FalImage | undefined;
  const url = first?.url ?? single?.url;
  return typeof url === 'string' ? url : '';
}

/**
 * Relight one photograph. `imageUrl` is one of our own storage URLs --
 * nothing a guest wrote reaches this.
 */
export async function runAiEnhance(imageUrl: string, strength?: number): Promise<AiEnhanceResult> {
  const key = falKey();
  if (!key) return { ok: false, error: 'not_configured' };
  if (!/^https:\/\//.test(imageUrl)) return { ok: false, error: 'invalid_source' };
  const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
  const input = {
    image_url: imageUrl,
    lighting_level: strengthFor(strength),
    output_format: 'jpeg',
  };

  try {
    const submit = await withTimeout(
      fetch(`https://queue.fal.run/${modelSlug()}`, {
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
    if (!queued.status_url.startsWith('https://queue.fal.run/')
      || !queued.response_url.startsWith('https://queue.fal.run/')) {
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
    // Pin the output host. This URL comes from fal's own authenticated
    // response rather than from a guest, but a fetch driven by a remote
    // JSON field should not be able to point anywhere it likes.
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
