/**
 * The three Fal calls the studio makes, behind one queue helper.
 *
 *   any-llm/vision   score a frame: is it a speaker, how is the face, glare
 *   any-llm          draft headlines from the programme text
 *   birefnet / evf-sam   cut the speaker out, masks for the lectern and the audience
 *
 * Same key and same queue protocol as event-media's ai-enhance.ts. Images
 * go up as data URIs so no storage URL has to be public for the model to
 * read it. Every model slug is a constant here, never configuration: the
 * slug is part of the request URL.
 */

const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 240_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

export const VISION_MODEL = 'google/gemini-flash-1.5';
export const TEXT_MODEL = 'google/gemini-flash-1.5';

export function falKey(): string | null {
  const key = process.env.FAL_API_KEY ?? '';
  return key.trim() ? key.trim() : null;
}

export function falConfigured(): boolean {
  return falKey() !== null;
}

function headers(): Record<string, string> {
  const key = falKey();
  if (!key) throw new Error('FAL_API_KEY is not configured');
  return { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
}

async function getJson(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`fal ${r.status} on ${new URL(url).pathname}`);
  return (await r.json()) as Record<string, unknown>;
}

/**
 * Submit to the queue and wait for the result. The status and response URLs
 * come back from Fal and are checked to be Fal's before they are followed.
 */
export async function queued(model: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!/^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9._-]*){1,3}$/.test(model)) throw new Error('bad model slug');
  const submit = await fetch(`https://queue.fal.run/${model}`, {
    method: 'POST', headers: headers(), body: JSON.stringify(payload), signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });
  if (!submit.ok) throw new Error(`fal submit ${submit.status} for ${model}: ${(await submit.text()).slice(0, 200)}`);
  const q = (await submit.json()) as { status_url?: string; response_url?: string };
  const su = String(q.status_url ?? ''); const ru = String(q.response_url ?? '');
  if (!su.startsWith('https://queue.fal.run/') || !ru.startsWith('https://queue.fal.run/')) throw new Error('fal returned a foreign queue URL');
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const s = await getJson(su, 15_000);
    if (s.status === 'COMPLETED') break;
    if (s.status === 'FAILED') throw new Error(`fal ${model} failed`);
    if (Date.now() > deadline) throw new Error(`fal ${model} timed out`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return getJson(ru, 30_000);
}

export function dataUri(bytes: Buffer, mime = 'image/jpeg'): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/** The first JSON object in a model's reply, or null. */
export function firstJson(text: string): Record<string, unknown> | null {
  const s = String(text ?? '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(s.slice(a, b + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Ask the vision model one question about one image; expects a JSON answer. */
export async function vision(image: Buffer, prompt: string): Promise<Record<string, unknown>> {
  const out = await queued('fal-ai/any-llm/vision', { model: VISION_MODEL, prompt, image_url: dataUri(image) });
  const j = firstJson(String(out.output ?? ''));
  if (!j) throw new Error('vision reply was not JSON');
  return j;
}

/** A plain text completion. */
export async function text(prompt: string, system?: string): Promise<string> {
  const out = await queued('fal-ai/any-llm', { model: TEXT_MODEL, prompt, ...(system ? { system_prompt: system } : {}) });
  return String(out.output ?? '');
}

/**
 * Download a result image Fal hosts, with a size cap. Result files live on
 * fal.media; nothing else is followed, and no redirect is either, so a
 * hosted app cannot bounce the worker to an address inside the cluster.
 */
export async function download(url: string): Promise<Buffer> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !/(^|\.)fal\.media$/.test(u.hostname)) throw new Error('refusing to download from a non-Fal host');
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!r.ok || !r.body) throw new Error(`download ${r.status}`);
  const reader = r.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) { await reader.cancel(); throw new Error('result image too large'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** The image a birefnet or evf-sam call produced, as bytes. */
export async function resultImage(out: Record<string, unknown>): Promise<Buffer> {
  const img = out.image as { url?: string } | undefined;
  const url = img?.url ?? (Array.isArray(out.images) ? (out.images[0] as { url?: string })?.url : undefined);
  if (!url) throw new Error('fal result had no image');
  return download(String(url));
}
