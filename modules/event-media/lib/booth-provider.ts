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
const DEFAULT_CUTOUT_MODEL = 'fal-ai/birefnet/v2';
const DEFAULT_VISION_MODEL = 'fal-ai/any-llm/vision';

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

export interface CardCopy {
  title: string;
  words: string[];
  kind: string;
  genre: string;
  eyebrow: string;
}

// Each genre is a title treatment on the browse card, so a wide list is
// not padding — it is what stops every photo arriving in the same
// logotype. The model was picking 'comedy' for most of the album.
const CARD_GENRES = [
  'horror', 'comedy', 'thriller', 'eighties', 'doc', 'romance', 'scifi',
  'crime', 'epic', 'noir', 'musical', 'reality', 'western', 'heist',
];

/**
 * Browse-screen copy for one photo: a spoof programme invented from
 * what is actually IN the picture.
 *
 * The register is the whole point and took several attempts to land.
 * Wedding-greeting-card phrasing ("Love Is In The Air") reads as cheesy
 * and was rejected repeatedly. Banning wordplay outright fixed that but
 * overcorrected: the titles became flat description ("The Lunch
 * Gathering"). What works is a real programme name that happens to carry
 * a second meaning — "Deep End" for a poolside photo — where the joke is
 * in the double meaning rather than in announcing itself.
 */
export async function runCardCopy(imageUrl: string): Promise<
  { ok: true; copy: CardCopy } | { ok: false; error: string }
> {
  // The model occasionally emits JSON it cannot itself parse (an
  // unescaped quote inside a descriptor is the usual culprit), and a
  // photo that misses here has no title for the rest of the night. One
  // retry costs a fraction of a penny and clears it.
  const first = await cardCopyOnce(imageUrl);
  if (first.ok || first.error === 'not_configured') return first;
  return cardCopyOnce(imageUrl);
}

async function cardCopyOnce(imageUrl: string): Promise<
  { ok: true; copy: CardCopy } | { ok: false; error: string }
> {
  if (!falEnabled()) return { ok: false, error: 'not_configured' };
  const key = falKey()!;
  const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
  const prompt = [
    'You are writing browse-screen copy for a spoof streaming service at a wedding.',
    'Invent a programme based on WHAT YOU ACTUALLY SEE in the photograph.',
    'Return ONLY minified JSON:',
    '{"title":"","words":["","",""],"kind":"Series|Films","genre":"' + CARD_GENRES.join('|') + '","eyebrow":""}',
    'title: one to three words that could be a real TV series or film on a',
    '  streaming service. Aim for a phrase that describes the photo literally',
    '  AND carries a second, funnier meaning — the wit comes from the double',
    '  meaning landing quietly, never from announcing itself.',
    '  Good: "Deep End" (people in a pool). "Floor Filler" (dancing).',
    '  "Table Manners" (dinner). "Last Orders" (the bar). "Plus One".',
    '  "Open Bar". "Heavy Pour". "The Long Game" (a very long speech).',
    '  Bad, because they are greeting-card phrases: "Love Is In The Air",',
    '  "Top Vows", "Happily Ever After", "Tying The Knot".',
    '  Bad, because they are flat description with no second meaning:',
    '  "The Lunch Gathering", "The Couple Photo", "The Extended Table".',
    '  Never explain the joke. Never use an exclamation mark.',
    'words: exactly three streaming descriptors, Title Case, one or two words each.',
    '  Vary them; do not open every one with "Candid". They should quietly',
    '  comment on the photo rather than describe a wedding.',
    'kind: "Series" or "Films".',
    'genre: pick the one whose title-card styling suits the photo. Spread your',
    '  choices across the list rather than defaulting to comedy — judge by the',
    '  light, colour and mood of the picture, not only by the joke.',
    'eyebrow: 1-3 words, Title Case, e.g. "Season One", "Limited Series",',
    '  "New Episodes", "A Wedflix Original".',
    'Never mention weddings, brides, grooms, vows or marriage in the title.',
  ].join('\n');

  try {
    const submit = await withTimeout(
      fetch(`https://queue.fal.run/${model('BOOTH_VISION_MODEL', DEFAULT_VISION_MODEL)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'google/gemini-flash-1.5', prompt, image_url: imageUrl }),
      }),
      SUBMIT_TIMEOUT_MS,
    );
    if (!submit.ok) return { ok: false, error: `submit ${submit.status}` };
    const queued = await submit.json() as FalQueued;
    if (!queued.status_url?.startsWith('https://queue.fal.run/') ||
        !queued.response_url?.startsWith('https://queue.fal.run/')) {
      return { ok: false, error: 'unexpected queue host' };
    }

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const poll = await withTimeout(fetch(queued.status_url, { headers }), SUBMIT_TIMEOUT_MS);
      if (!poll.ok) continue;
      const state = await poll.json() as { status?: string };
      if (state.status === 'COMPLETED') break;
      if (state.status !== 'IN_QUEUE' && state.status !== 'IN_PROGRESS') {
        return { ok: false, error: String(state.status ?? 'unknown') };
      }
    }

    const resp = await withTimeout(fetch(queued.response_url, { headers }), SUBMIT_TIMEOUT_MS);
    if (!resp.ok) return { ok: false, error: `result ${resp.status}` };
    const body = await resp.json() as { output?: unknown; text?: unknown };
    const raw = typeof body.output === 'string' ? body.output
      : typeof body.text === 'string' ? body.text : '';
    const match = /\{[\s\S]*\}/.exec(raw);
    if (!match) return { ok: false, error: 'no json' };
    const parsed = JSON.parse(match[0]) as Partial<CardCopy>;

    // The model is writing display copy, so everything is clamped and
    // allowlisted before it can reach the projector.
    const clean = (v: unknown, max: number) =>
      typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '';
    const title = clean(parsed.title, 48);
    const words = Array.isArray(parsed.words)
      ? parsed.words.map((w) => clean(w, 24)).filter(Boolean).slice(0, 3)
      : [];
    if (!title || words.length !== 3) return { ok: false, error: 'incomplete' };

    return {
      ok: true,
      copy: {
        title,
        words,
        kind: parsed.kind === 'Films' ? 'Films' : 'Series',
        genre: CARD_GENRES.includes(String(parsed.genre)) ? String(parsed.genre) : 'doc',
        eyebrow: clean(parsed.eyebrow, 28),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 120) : 'failed' };
  }
}

/**
 * The people, cut out with a soft alpha edge.
 *
 * Half of the projector's 3D effect: the near layer. Paired with the
 * plate below, the two can be moved at different rates to give real
 * parallax — as opposed to displacing one flat image by a depth map,
 * which smears at every edge because there is nothing behind the
 * subject to reveal.
 */
export async function runCutout(imageUrl: string): Promise<BoothResult> {
  if (!falEnabled()) return { ok: false, error: 'not_configured' };
  return runFal(model('BOOTH_CUTOUT_MODEL', DEFAULT_CUTOUT_MODEL), { image_url: imageUrl });
}

/**
 * The scene as if nobody had been standing in it — the far layer.
 *
 * This is the piece that makes parallax honest. When the camera drifts
 * and the people move against the background, what is revealed behind
 * them is real reconstructed scene rather than stretched neighbouring
 * pixels.
 */
export async function runPlate(imageUrl: string): Promise<BoothResult> {
  if (!falEnabled()) return { ok: false, error: 'not_configured' };
  return runFal(model('BOOTH_STYLE_MODEL', DEFAULT_STYLE_MODEL), {
    prompt:
      'Remove the people from this photograph completely. Reconstruct the scene behind them ' +
      'plausibly and seamlessly, continuing the walls, furniture, floor and background exactly as ' +
      'they would appear with nobody standing there. Keep the camera angle, framing, lighting, ' +
      'colour and every remaining detail identical. The result must contain no people at all.',
    image_urls: [imageUrl],
    output_format: 'jpeg',
  });
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
