/**
 * Running the enhancement over an album, from the Media tab.
 *
 * The server does a few photographs per call -- each one is a model
 * looking at it, which takes seconds -- so the walk is here, a batch at a
 * time, with a count the organiser can watch. Closing the modal stops it;
 * what has been done stays done, and running it again picks up where it
 * left off because a photograph already looked at is left alone.
 */
import { supabase } from '@/lib/supabase';

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
const apiUrl = env.VITE_API_URL ?? '';

/** What one call will take; the server caps it at the same number. */
export const ENHANCE_BATCH = 6;

export interface EnhanceProgress {
  done: number;
  total: number;
  enhanced: number;
  unchanged: number;
  failed: number;
}

export interface EnhanceResult {
  id: string;
  status: 'enhanced' | 'unchanged' | 'skipped' | 'failed';
  note?: string;
  reason?: string;
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data: session } = await supabase.auth.getSession();
  const headers = new Headers(init?.headers);
  const token = session.session?.access_token;
  if (token) headers.set('Authorization', `Bearer ${token}`);
  headers.set('Content-Type', 'application/json');
  return fetch(`${apiUrl}${path}`, { ...init, headers });
}

/**
 * Walk a list of photographs, a batch at a time. `onProgress` is called
 * after each batch; returning false from `keepGoing` stops the walk.
 */
export async function enhanceMedia(
  eventId: string,
  ids: string[],
  onProgress: (p: EnhanceProgress) => void,
  keepGoing: () => boolean = () => true,
): Promise<EnhanceProgress> {
  const progress: EnhanceProgress = { done: 0, total: ids.length, enhanced: 0, unchanged: 0, failed: 0 };
  for (let i = 0; i < ids.length; i += ENHANCE_BATCH) {
    if (!keepGoing()) break;
    const batch = ids.slice(i, i + ENHANCE_BATCH);
    const resp = await authedFetch(`/api/admin/events/${eventId}/media/enhance`, {
      method: 'POST',
      body: JSON.stringify({ ids: batch }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => null);
      throw new Error(body?.message ?? `The enhancement stopped after ${progress.done} photos`);
    }
    const body = (await resp.json()) as { results: EnhanceResult[] };
    for (const r of body.results ?? []) {
      if (r.status === 'enhanced') progress.enhanced += 1;
      else if (r.status === 'unchanged') progress.unchanged += 1;
      else progress.failed += 1;
    }
    progress.done += batch.length;
    onProgress({ ...progress });
  }
  return progress;
}
