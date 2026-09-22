// @ts-nocheck — depends on @supabase/supabase-js + express which require
// pnpm install at the modules workspace level.
/**
 * Make the photo booth's example pictures from the event's key people.
 *
 *   POST /admin/events/:eventId/booth/examples   start (one job per event)
 *   GET  /admin/events/:eventId/booth/examples   progress
 *
 * Every look in every decade gets a new sample picture of the key people
 * (lib/booth-eras.ts decides which looks; lib/booth-effects.ts writes the
 * prompt). The finished pictures are stored beside the booth's artwork
 * under fresh names -- the CDN caches by name, so overwriting would keep
 * serving the old ones -- and theme.json is updated to point at them.
 * Looks that fail keep their previous sample.
 *
 * Spend: one model call per look (54 today, about $2). Admin-only, one
 * job per event at a time, and the photo paths are checked to lie inside
 * the event's own key-people folder before any of them leaves for the
 * model.
 */
import type { Request, Response, Router } from 'express';
import { BOOTH_ERAS } from '../lib/booth-eras.js';
import { boothEffect, buildSamplePrompt } from '../lib/booth-effects.js';
import type { BoothResult } from '../lib/booth-provider.js';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface BoothExamplesDeps {
  canAdminEvent: (req: Request, eventId: string) => Promise<boolean | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceClient: any;
  storageBucket: string;
  /** A URL the image model can fetch the object from. */
  publicUrl: (path: string) => string;
  runRefs: (urls: string[], prompt: string) => Promise<BoothResult>;
  logger: PlatformLogger;
  concurrency?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REFS = 10;

export interface JobStatus {
  state: 'running' | 'done' | 'failed';
  total: number;
  done: number;
  failed: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

/**
 * The references the model gets, fairly shared: everyone's first photo,
 * then everyone's second, and so on, up to ten. Returned grouped per
 * person, in order, because the prompt names them by image position.
 */
export function pickReferences(
  people: ReadonlyArray<{ name: string; photos: string[] }>,
  max: number = MAX_REFS,
): Array<{ name: string; photos: string[] }> {
  const take = people.map(() => 0);
  let left = max;
  for (let round = 0; left > 0; round++) {
    let any = false;
    people.forEach((p, i) => {
      if (left > 0 && round < p.photos.length) { take[i]++; left--; any = true; }
    });
    if (!any) break;
  }
  return people.map((p, i) => ({ name: p.name, photos: p.photos.slice(0, take[i]) })).filter((p) => p.photos.length > 0);
}

export function createBoothExamples(deps: BoothExamplesDeps) {
  const { canAdminEvent, serviceClient: db, storageBucket, publicUrl, runRefs, logger } = deps;
  const jobs = new Map<string, JobStatus>();

  async function authorise(req: Request, res: Response): Promise<string | null> {
    const eventId = req.params['eventId'];
    if (typeof eventId !== 'string' || !UUID_RE.test(eventId)) {
      sendError(res, 400, 'invalid_event_id', 'eventId must be a UUID');
      return null;
    }
    let allowed: boolean | null;
    try {
      allowed = await canAdminEvent(req, eventId);
    } catch {
      allowed = false;
    }
    if (allowed === null) { sendError(res, 401, 'unauthenticated', 'session required'); return null; }
    if (!allowed) { sendError(res, 403, 'forbidden', 'not authorised for this event'); return null; }
    return eventId;
  }

  async function run(eventId: string, people: Array<{ name: string; photos: string[] }>, job: JobStatus) {
    const refs = pickReferences(people);
    const urls = refs.flatMap((p) => p.photos.map(publicUrl));
    const counts = refs.map((p) => ({ name: p.name, photos: p.photos.length }));
    const stamp = Date.now().toString(36);
    const dir = `event/${eventId}/booth-theme`;
    const made: Record<string, Record<string, string>> = {};

    const work = BOOTH_ERAS.flatMap((era) => era.looks.map((look) => ({ era: era.key, look })));
    job.total = work.length;
    let next = 0;
    const worker = async () => {
      while (next < work.length) {
        const { era, look } = work[next++]!;
        const effect = boothEffect(look);
        try {
          if (!effect?.style) throw new Error('unknown look');
          const r = await runRefs(urls, buildSamplePrompt(effect, counts));
          if (!r.ok) throw new Error(r.error);
          const name = `sample-${look}-${stamp}.jpg`;
          const { error } = await db.storage.from(storageBucket)
            .upload(`${dir}/${name}`, Buffer.from(r.image), { contentType: r.contentType || 'image/jpeg', upsert: true });
          if (error) throw new Error(error.message);
          (made[era] ??= {})[look] = name;
          job.done++;
        } catch (err) {
          job.failed++;
          logger.warn('booth example failed', { eventId, look, error: err instanceof Error ? err.message : String(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, deps.concurrency ?? 4) }, worker));

    // Point the theme at the new pictures. Eras the theme has no booth for
    // are skipped: a sample without an interior is never shown.
    const { data: blob, error: readErr } = await db.storage.from(storageBucket).download(`${dir}/theme.json`);
    if (readErr || !blob) throw new Error('the booth has no theme to update');
    const theme = JSON.parse(await blob.text());
    for (const [era, looks] of Object.entries(made)) {
      const e = theme?.eras?.[era];
      if (!e || typeof e !== 'object') continue;
      e.samples = { ...(e.samples ?? {}), ...looks };
    }
    const { error: writeErr } = await db.storage.from(storageBucket)
      .upload(`${dir}/theme.json`, Buffer.from(JSON.stringify(theme, null, 1)), { contentType: 'application/json', upsert: true, cacheControl: '60' });
    if (writeErr) throw new Error(writeErr.message);
  }

  async function start(req: Request, res: Response): Promise<void> {
    const eventId = await authorise(req, res);
    if (!eventId) return;
    if (jobs.get(eventId)?.state === 'running') {
      res.status(202).json({ job: jobs.get(eventId) });
      return;
    }
    const { data, error } = await db
      .from('events_media_key_people')
      .select('name, photos')
      .eq('event_id', eventId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) { sendError(res, 500, 'read_failed', 'could not read the key people'); return; }
    // Only paths inside this event's own key-people folder go to the model.
    const prefix = `event/${eventId}/key-people/`;
    const people = ((data ?? []) as Array<{ name: string; photos: string[] | null }>)
      .map((p) => ({
        name: String(p.name).trim().slice(0, 60),
        photos: (p.photos ?? []).filter((x) => typeof x === 'string' && x.startsWith(prefix) && !x.includes('..')).slice(0, 5),
      }))
      .filter((p) => p.name && p.photos.length > 0);
    if (people.length === 0) {
      sendError(res, 400, 'no_key_people', 'add at least one key person with a photo first');
      return;
    }

    const job: JobStatus = { state: 'running', total: 0, done: 0, failed: 0, startedAt: new Date().toISOString() };
    jobs.set(eventId, job);
    void run(eventId, people, job)
      .then(() => { job.state = job.done > 0 ? 'done' : 'failed'; })
      .catch((err) => {
        job.state = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        logger.error('booth examples failed', { eventId, error: job.error });
      })
      .finally(() => { job.finishedAt = new Date().toISOString(); });
    res.status(202).json({ job });
  }

  async function status(req: Request, res: Response): Promise<void> {
    const eventId = await authorise(req, res);
    if (!eventId) return;
    res.status(200).json({ job: jobs.get(eventId) ?? null });
  }

  return { start, status, _jobs: jobs };
}

export function mountBoothExamples(router: Router, routes: ReturnType<typeof createBoothExamples>): void {
  router.post('/events/:eventId/booth/examples', routes.start);
  router.get('/events/:eventId/booth/examples', routes.status);
}
