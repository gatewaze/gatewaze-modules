/**
 * Finding the faces in an album, in the organiser's browser.
 *
 * The server says which photographs it has not looked at and where to
 * fetch a small copy of each; the detector runs here; rectangles go
 * back as numbers. The api never sees a pixel — it has 512Mi for
 * everything it does, and decoding photographs in it has taken the site
 * down three times (see lib/bounded.ts). A laptop has memory to spare
 * and takes nobody else down when it struggles.
 *
 * BOXES ONLY. Nothing here produces a face template, an embedding, or
 * anything that could tell one person from another. A rectangle is
 * personal data; a template is Article 9 biometric data; this is firmly
 * on the first side of that line and needs nobody's explicit consent.
 *
 * The detector is MediaPipe's, Apache-2.0 (verified against the npm
 * registry 2026-10-17), fetched at RUNTIME from a CDN exactly as
 * portal/.../ai-pipeline.ts fetches transformers.js — so it is not a
 * build dependency of this module or of admin. MediaPipe decodes its own
 * output and does its own non-maximum suppression, which is why it was
 * chosen over YuNet: YuNet is also MIT, but emits twelve raw per-stride
 * heads that would have to be decoded here by hand, with nothing to
 * check the result against.
 */
import { supabase } from '@/lib/supabase';
import { normaliseBox } from '../../lib/faces';

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
const apiUrl = env.VITE_API_URL ?? '';

/**
 * Pinned, because an unpinned CDN import would change the model API
 * under us between one album and the next.
 */
const MEDIAPIPE_VERSION = '0.10.35';
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const LIB_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

/**
 * What wrote a row. Stored per scan, so changing detector re-offers
 * every photograph without a migration or a flag.
 */
export const MODEL_ID = `mediapipe-blazeface-short@${MEDIAPIPE_VERSION}`;

/** Below this the detector is guessing, and we would rather have nothing. */
const MIN_SCORE = 0.5;

/** Photographs asked for at a time. */
const PAGE = 50;

export interface FaceProgress {
  done: number;
  /** Photographs still unscanned, as the server last reported it. */
  remaining: number;
  faces: number;
  failed: number;
  /** Rolling median of the per-photograph cost, in ms. */
  medianMs: number | null;
}

interface Pending { id: string; url: string; width: number | null; height: number | null }

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data: session } = await supabase.auth.getSession();
  const headers = new Headers(init?.headers);
  const token = session.session?.access_token;
  if (token) headers.set('Authorization', `Bearer ${token}`);
  headers.set('Content-Type', 'application/json');
  return fetch(`${apiUrl}${path}`, { ...init, headers });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let detector: any = null;
let loading: Promise<unknown> | null = null;

/**
 * Load the detector once per session.
 *
 * A failure here is terminal for the run rather than retried per
 * photograph: if the CDN is unreachable, it will be unreachable for all
 * 851 of them, and the useful thing is to say so once.
 */
async function load(): Promise<unknown> {
  if (detector) return detector;
  if (loading) return loading;
  loading = (async () => {
    const vision = await import(/* webpackIgnore: true */ /* @vite-ignore */ LIB_URL);
    const files = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
    detector = await vision.FaceDetector.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL_URL },
      runningMode: 'IMAGE',
      minDetectionConfidence: MIN_SCORE,
    });
    return detector;
  })();
  try {
    return await loading;
  } catch (err) {
    loading = null;
    throw err;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // The detector reads the decoded pixels, so the fetch has to be
    // CORS-clean. The CDN answers with access-control-allow-origin.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not load the photo'));
    img.src = src;
  });
}

/**
 * Find the faces in one photograph.
 *
 * Returns fractions of the frame, so the answer does not depend on the
 * width the copy happened to be fetched at.
 */
async function facesIn(img: HTMLImageElement, originalWidth: number | null): Promise<Array<{
  x: number; y: number; w: number; h: number; score: number; px: number | null;
}>> {
  const det = await load();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = (det as any).detect(img);
  const frame = { w: img.naturalWidth, h: img.naturalHeight };
  // How much bigger the stored original is than the copy we looked at,
  // so a face can be reported in the original's own pixels.
  const scale = originalWidth && frame.w > 0 ? originalWidth / frame.w : 1;

  const faces = [];
  for (const d of (out?.detections ?? [])) {
    const bb = d?.boundingBox;
    if (!bb) continue;
    const box = normaliseBox(
      { x: bb.originX, y: bb.originY, w: bb.width, h: bb.height },
      frame,
    );
    if (!box) continue;
    const score = Number(d?.categories?.[0]?.score);
    if (!Number.isFinite(score) || score < MIN_SCORE) continue;
    faces.push({
      ...box,
      score: Math.max(0, Math.min(1, score)),
      px: Number.isFinite(bb.width) ? Math.round(Math.max(bb.width, bb.height) * scale) : null,
    });
  }
  return faces;
}

/**
 * Walk an event's unscanned photographs.
 *
 * `onProgress` is called as each one is finished. Returning false from
 * `keepGoing` stops the walk, and what has been scanned stays scanned —
 * a photograph already looked at is not offered again, so closing the
 * tab costs only what was in flight.
 */
export async function detectFaces(
  eventId: string,
  onProgress: (p: FaceProgress) => void,
  keepGoing: () => boolean = () => true,
  /** Look again at photographs this detector has already finished with. */
  force = false,
): Promise<FaceProgress> {
  const progress: FaceProgress = { done: 0, remaining: 0, faces: 0, failed: 0, medianMs: null };
  const times: number[] = [];

  // Load before asking for work, so an unreachable CDN fails before
  // anything has been half-done.
  await load();

  for (;;) {
    if (!keepGoing()) break;
    const resp = await authedFetch(`/api/admin/events/${eventId}/faces/pending`, {
      method: 'POST',
      body: JSON.stringify({ limit: PAGE, model_id: MODEL_ID, force }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => null);
      throw new Error(body?.message ?? `the scan stopped after ${progress.done} photographs`);
    }
    const { items, remaining } = (await resp.json()) as { items: Pending[]; remaining: number };
    if (!items || items.length === 0) { progress.remaining = 0; break; }
    progress.remaining = remaining + items.length;

    for (const item of items) {
      if (!keepGoing()) break;
      const began = performance.now();
      try {
        const img = await loadImage(item.url);
        const faces = await facesIn(img, item.width);
        const took = Math.round(performance.now() - began);
        times.push(took);
        const rec = await authedFetch(`/api/admin/events/${eventId}/faces`, {
          method: 'POST',
          body: JSON.stringify({
            media_id: item.id, model_id: MODEL_ID, took_ms: took, faces,
          }),
        });
        if (!rec.ok) throw new Error('could not record those faces');
        progress.faces += faces.length;
      } catch {
        // One photograph that will not scan must not stop the album.
        progress.failed += 1;
      }
      progress.done += 1;
      progress.remaining = Math.max(0, progress.remaining - 1);
      if (times.length > 0) {
        const sorted = [...times].sort((a, b) => a - b);
        progress.medianMs = sorted[Math.floor(sorted.length / 2)]!;
      }
      onProgress({ ...progress });
    }
    // `force` re-offers the same photographs for ever otherwise: after
    // the first page they have all been scanned by this model already.
    if (force) break;
  }

  return progress;
}
