/**
 * Face-swap provider abstraction.
 *
 * The swap runs on a hosted GPU because the models that produce a
 * convincing result are far too heavy for the browser (the on-device
 * depth/matte pipeline already costs ~10 s per photo on WASM, and
 * those models are a fraction of the size).
 *
 * Deliberately pluggable and deliberately absent by default: with no
 * provider configured the whole feature reports unavailable and the
 * guest UI never offers it. Nothing on the wedding-day upload path
 * depends on this.
 *
 * Configure with:
 *   FACE_SWAP_PROVIDER=replicate
 *   REPLICATE_API_TOKEN=<token>
 *   FACE_SWAP_MODEL=<owner/name:version>   (optional override)
 *
 * NOTE on provider choice: OpenAI's image models refuse identity
 * manipulation of real people, so an OPENAI_API_KEY — which every
 * brand already has — cannot drive this. A Replicate/fal token is a
 * separate, deliberate decision because it costs money per photo and
 * carries its own terms about likeness.
 */

export type FaceSwapResult =
  | { ok: true; image: Uint8Array; contentType: string }
  | { ok: false; error: 'not_configured' | 'provider_error' | 'no_face' | 'timeout'; detail?: string };

const REQUEST_TIMEOUT_MS = 90_000;
// Replicate's hosted inswapper-style endpoint. Pinned by env when a
// deployment wants a different model; left unpinned here so the token
// owner chooses what they are comfortable running.
//
// Read on each call rather than captured at import: a module-level
// const freezes whatever the environment happened to be when this file
// was first imported, which made the feature's own status lie whenever
// the module loaded before the env was populated.
function configuredModel(): string {
  return process.env.FACE_SWAP_MODEL ?? '';
}

export function faceSwapConfigured(): boolean {
  return Boolean(
    (process.env.FACE_SWAP_PROVIDER ?? '').toLowerCase() === 'replicate' &&
    process.env.REPLICATE_API_TOKEN &&
    configuredModel(),
  );
}

/** Why the feature is off, for the admin panel to display. */
export function faceSwapStatus(): { configured: boolean; reason?: string } {
  const provider = (process.env.FACE_SWAP_PROVIDER ?? '').toLowerCase();
  if (!provider) return { configured: false, reason: 'FACE_SWAP_PROVIDER is not set' };
  if (provider !== 'replicate') return { configured: false, reason: `unknown provider "${provider}"` };
  if (!process.env.REPLICATE_API_TOKEN) return { configured: false, reason: 'REPLICATE_API_TOKEN is not set' };
  if (!configuredModel()) return { configured: false, reason: 'FACE_SWAP_MODEL is not set' };
  return { configured: true };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/**
 * Swap the face from `sourceUrl` (the reference person) onto
 * `targetUrl` (the guest's selfie). Both must be publicly readable
 * URLs — the provider fetches them itself.
 */
export async function runFaceSwap(sourceUrl: string, targetUrl: string): Promise<FaceSwapResult> {
  if (!faceSwapConfigured()) return { ok: false, error: 'not_configured' };
  const token = process.env.REPLICATE_API_TOKEN!;
  const configured = configuredModel();

  try {
    const create = await withTimeout(
      fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          // Ask Replicate to hold the connection open so we usually
          // get a finished prediction without polling at all.
          Prefer: 'wait=60',
        },
        body: JSON.stringify({
          version: configured.includes(':') ? configured.split(':')[1] : undefined,
          model: configured.includes(':') ? undefined : configured,
          input: { swap_image: sourceUrl, input_image: targetUrl },
        }),
      }),
      REQUEST_TIMEOUT_MS,
    );

    if (!create.ok) {
      const detail = (await create.text().catch(() => '')).slice(0, 300);
      return { ok: false, error: 'provider_error', detail: `${create.status} ${detail}` };
    }

    let prediction = await create.json() as { status?: string; output?: unknown; error?: unknown; urls?: { get?: string } };

    // Poll only if the Prefer: wait hint was not enough.
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    while (
      prediction.status && ['starting', 'processing'].includes(prediction.status) &&
      Date.now() < deadline && prediction.urls?.get
    ) {
      await new Promise((r) => setTimeout(r, 2000));
      const poll = await fetch(prediction.urls.get, { headers: { Authorization: `Bearer ${token}` } });
      if (!poll.ok) break;
      prediction = await poll.json();
    }

    if (prediction.status !== 'succeeded') {
      if (prediction.status === 'failed') {
        const msg = String(prediction.error ?? '').slice(0, 200);
        // The usual failure on a guest selfie is simply no detectable
        // face — worth telling them rather than showing an error.
        if (/face/i.test(msg)) return { ok: false, error: 'no_face', detail: msg };
        return { ok: false, error: 'provider_error', detail: msg };
      }
      return { ok: false, error: 'timeout' };
    }

    const out = prediction.output;
    const imageUrl = typeof out === 'string' ? out : Array.isArray(out) ? String(out[0] ?? '') : '';
    if (!/^https:\/\//.test(imageUrl)) {
      return { ok: false, error: 'provider_error', detail: 'no output image' };
    }

    const img = await withTimeout(fetch(imageUrl), 30_000);
    if (!img.ok) return { ok: false, error: 'provider_error', detail: `fetch output ${img.status}` };
    const buf = new Uint8Array(await img.arrayBuffer());
    const contentType = (img.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim();
    if (!contentType.startsWith('image/')) {
      return { ok: false, error: 'provider_error', detail: `unexpected type ${contentType}` };
    }
    return { ok: true, image: buf, contentType };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg === 'timeout' ? 'timeout' : 'provider_error', detail: msg.slice(0, 200) };
  }
}
