/**
 * Adding to a photograph rather than cutting it down.
 *
 * A phone gives you 3:4; a camera gives you 2:3. Matching the shape can
 * be done either way -- crop about a ninth off the width, or add the
 * same amount of height. lib/framing.ts works out both. This is the
 * second: a model draws what lies outside the frame.
 *
 * THE LIKENESS IS SAFE BY CONSTRUCTION, NOT BY PROMISE. Everything the
 * model is asked for is outside the photograph, and the browser lays the
 * original back over the result before anything is kept. A generated
 * pixel therefore cannot end up inside the frame at all, let alone on a
 * face -- not because the model was asked nicely, but because there is
 * nowhere for it to go. That is the only reason this is allowed near
 * photographs of real guests when relighting had to be kept apart.
 *
 * The margins come from the browser, which is the only thing that has
 * decoded the photograph. They are numbers, so they are checked here
 * rather than trusted: fal caps a side at 700px and so does this.
 */

export type ExpandResult =
  | { ok: true; image: Uint8Array; contentType: string }
  | { ok: false; error: string; detail?: string };

const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 2_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

const DEFAULT_MODEL = 'fal-ai/image-apps-v2/outpaint';
const MODEL_RE = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9._-]*){1,3}$/;

/** What the provider will add to one side, and so what we will ask for. */
export const MAX_MARGIN = 700;

export interface Margins { left: number; right: number; top: number; bottom: number }

function falKey(): string | null {
  const key = process.env['FAL_API_KEY'] ?? '';
  return key.trim() ? key.trim() : null;
}

function modelSlug(): string {
  const raw = (process.env['EVENT_MEDIA_EXPAND_MODEL'] ?? '').trim();
  return raw && MODEL_RE.test(raw) ? raw : DEFAULT_MODEL;
}

export function expandConfigured(): boolean {
  return falKey() !== null;
}

/** The margins, as whole pixels inside what the provider will accept. */
export function marginsFrom(raw: unknown): Margins | null {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const side = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return null;
    const i = Math.round(n);
    return i >= 0 && i <= MAX_MARGIN ? i : null;
  };
  const left = side(r['left']), right = side(r['right']);
  const top = side(r['top']), bottom = side(r['bottom']);
  if (left === null || right === null || top === null || bottom === null) return null;
  // Nothing to do is not an error, but it is not worth paying for.
  if (left + right + top + bottom === 0) return null;
  return { left, right, top, bottom };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

interface FalQueued { status_url?: string; response_url?: string }
interface FalImage { url?: string }

function outputUrl(res: Record<string, unknown>): string {
  const images = res['images'];
  const first = Array.isArray(images) ? (images[0] as FalImage | undefined) : undefined;
  const single = res['image'] as FalImage | undefined;
  const url = first?.url ?? single?.url;
  return typeof url === 'string' ? url : '';
}

/** Draw what lies outside one photograph. `imageUrl` is our own storage. */
export async function runExpand(imageUrl: string, margins: Margins): Promise<ExpandResult> {
  const key = falKey();
  if (!key) return { ok: false, error: 'not_configured' };
  if (!/^https:\/\//.test(imageUrl)) return { ok: false, error: 'invalid_source' };
  const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
  const input = {
    image_url: imageUrl,
    expand_left: margins.left,
    expand_right: margins.right,
    expand_top: margins.top,
    expand_bottom: margins.bottom,
    output_format: 'jpeg',
  };

  try {
    const submit = await withTimeout(
      fetch(`https://queue.fal.run/${modelSlug()}`, {
        method: 'POST', headers, body: JSON.stringify(input),
      }),
      SUBMIT_TIMEOUT_MS,
    );
    if (!submit.ok) {
      const detail = (await submit.text().catch(() => '')).slice(0, 300);
      return { ok: false, error: 'provider_error', detail: `${submit.status} ${detail}` };
    }
    const queued = await submit.json() as FalQueued;
    if (!queued.status_url || !queued.response_url
      || !queued.status_url.startsWith('https://queue.fal.run/')
      || !queued.response_url.startsWith('https://queue.fal.run/')) {
      return { ok: false, error: 'provider_error', detail: 'unexpected queue urls' };
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
    const url = outputUrl(await resp.json() as Record<string, unknown>);
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
