// @ts-nocheck — supabase-js + express are resolved at module-host install time.

/**
 * The video editor's API (spec §16.2, §18).
 *
 * Mounted under /api/video-editor/*. NOT under /api/modules/videos/*, because
 * the platform applies requireSuperAdmin() to that whole prefix and a
 * third-party editor would get 403 forever (confirmed against a real editor
 * account before the mount moved).
 *
 * register-routes.ts authenticates the caller before any of these run. Each
 * handler then authorises as the CALLER via can_edit_videos_for() before
 * touching anything with the service role.
 *
 * That split is the whole security model and it is worth stating plainly:
 * being signed in proves nothing here. A third-party video editor is signed
 * in. Without the per-subject check, an editor granted one event could read
 * and write every other event's videos by guessing a uuid.
 *
 * Uploads never pass through here. The mint step signs a ticket describing the
 * upload it authorised; the browser PUTs the bytes straight to storage with a
 * signed URL; the complete step verifies the ticket and the stored object. The
 * API container never sees a gigabyte.
 */

import type { Request, Response, Router } from 'express';
import { rejectUpload, buildStoragePath, MAX_BYTES, allowedMimes, type UploadKind } from '../lib/upload-rules.js';
import { mintTicket, verifyTicket, ticketsAvailable, TICKET_TTL_SECONDS } from '../lib/upload-tickets.js';
import { storeForNew, storeFor } from '../lib/storage.js';
import { generateCopy } from '../lib/titles.js';
import { mountStudioRoutes } from './studio-routes.js';

/**
 * How long a command-line upload URL stays valid. A browser upload is
 * minted and used in one sitting; a 10 GB file over a hotel connection is
 * not, so the URL the editor pastes into curl gets most of a day.
 */
export const CLI_UPLOAD_TTL_SECONDS = 12 * 60 * 60;

/** The one-liner shown next to a command-line upload URL. Paths are the editor's own. */
export function cliUploadCommand(uploadUrl: string, mimeType: string, filename: string): string {
  const safeName = String(filename ?? 'video.mp4').replace(/[^A-Za-z0-9._ -]+/g, '_');
  return `curl -T "${safeName}" -H "Content-Type: ${mimeType}" "${uploadUrl}"`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Subject types an editor may work against, per spec §16.2 step 4. */
const SUBJECT_TYPES = new Set(['event', 'podcast']);

/** Visibility values, mirroring the platforms' own vocabulary (spec §19). */
const VISIBILITIES = new Set(['public', 'unlisted', 'private']);

/**
 * Platforms a video can come from, mirroring the videos.provider CHECK.
 *
 * An allowlist rather than passing the query parameter through, because it
 * reaches a PostgREST filter. Keep it in step with the constraint in
 * migration 001; an unknown value here filters to nothing rather than
 * erroring, which is the right failure for a filter.
 */
const PROVIDERS = new Set([
  'youtube', 'tiktok', 'linkedin', 'instagram', 'x',
  'vimeo', 'spotify', 'apple_podcasts', 'gatewaze',
]);

/** How many rows any list endpoint will return. */
const PAGE = 200;

/**
 * A link that is safe to put in an href, or null.
 *
 * videos.url is whatever the platform said it was: YouTube's API for a
 * discovered video, an RSS <link> for an episode. Nothing constrains the
 * column, so a `javascript:` or `data:text/html` value would reach the admin
 * as an href and run in the admin's own origin when somebody clicked it.
 * Checked here rather than in each component, so one forgotten render site
 * cannot reintroduce it.
 */
export function safeLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return /^https?:\/\//i.test(value.trim()) ? value.trim() : null;
}

/**
 * A caller's search text, reduced to something safe to put in an ilike.
 *
 * Three separate reasons for the scrubbing, none of them optional:
 *
 *   - `%` and `_` are ilike wildcards. A search for "100%" would otherwise
 *     match everything, which reads as a broken filter rather than a clever
 *     one.
 *   - `,`, `(` and `)` are PostgREST's own filter syntax. This value does not
 *     currently go into an .or(), but the next person to add one would
 *     inherit a filter-injection hole from a helper that looked sanitised.
 *   - an unbounded term is a free table scan on every keystroke.
 *
 * Returns null for anything that cleans down to nothing, which the callers
 * treat as "no search" rather than as "match empty string".
 */
/**
 * Event ids that are actually workable: they have agenda sessions AND
 * speakers.
 *
 * Without this the picker offers every past event, and step 3 then shows an
 * empty talk list for almost all of them, because the next step enumerates
 * agenda entries. On AAIF prod that is 5,919 past events of which 1 has an
 * agenda, so the filter is the difference between a usable picker and a long
 * list of dead ends.
 *
 * Ordered so the restrictive side runs first: read the distinct events that
 * have an agenda (a small set), then ask about speakers for only those ids.
 * Doing it the other way round reads the 2,307 events that have speakers and
 * throws nearly all of them away.
 */
async function workableEventIds(supabase: EditorDeps['supabase']): Promise<Set<string>> {
  const withAgenda = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('events_agenda_entries')
      .select('event_uuid')
      .not('event_uuid', 'is', null)
      .range(from, from + 999);
    if (error) break;
    const batch = data ?? [];
    for (const r of batch) if (r?.event_uuid) withAgenda.add(String(r.event_uuid));
    if (batch.length < 1000) break;
  }
  if (withAgenda.size === 0) return withAgenda;

  const workable = new Set<string>();
  const ids = [...withAgenda];
  // Chunked: a very long .in() list becomes a URL the gateway rejects.
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase
      .from('events_speakers')
      .select('event_uuid')
      .in('event_uuid', ids.slice(i, i + 200));
    for (const r of data ?? []) if (r?.event_uuid) workable.add(String(r.event_uuid));
  }
  return workable;
}

export function searchTerm(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[%_,()*\\]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : null;
}

export interface EditorDeps {
  /** Service role, for the writes RLS intentionally denies to authenticated. */
  supabase: { from(t: string): any; storage: any; rpc(fn: string, args?: unknown): any };
  /** A client scoped to the caller's own JWT, for the permission checks. */
  userClient: (req: Request) => any | null;
  logger: { info: (m: string, x?: Record<string, unknown>) => void; warn: (m: string, x?: Record<string, unknown>) => void };
  enqueueJob?: (queue: string, name: string, data: Record<string, unknown>) => Promise<{ id: string | undefined }>;
}

export function mountEditorRoutes(router: Router, deps: EditorDeps): void {
  const { supabase, userClient, logger, enqueueJob } = deps;

  /** The caller's own auth user id, read from the token rather than the body. */
  async function callerId(req: Request): Promise<string | null> {
    try {
      const asUser = userClient(req);
      if (!asUser) return null;
      const { data } = await asUser.auth.getUser();
      const id = data?.user?.id;
      return UUID_RE.test(String(id ?? '')) ? String(id) : null;
    } catch {
      return null;
    }
  }

  /**
   * Does the caller hold any editor grant at all?
   *
   * Run as the caller so the SECURITY DEFINER predicate sees their auth.uid().
   * Calling it with the service role would evaluate auth.uid() as null and
   * deny everyone, which is the right failure direction but useless.
   */
  async function denyUnlessAnyGrant(req: Request, res: Response): Promise<boolean> {
    const asUser = userClient(req);
    if (!asUser) {
      res.status(401).json({ error: 'session required' });
      return true;
    }
    const { data, error } = await asUser.rpc('can_edit_any_videos');
    if (error || data !== true) {
      if (error) logger.warn('can_edit_any_videos failed', { error: error.message });
      res.status(403).json({ error: 'no video editor access' });
      return true;
    }
    return false;
  }

  /** May the caller edit videos for this specific subject? */
  async function denyUnlessSubject(
    req: Request,
    res: Response,
    subjectType: string,
    subjectId: string,
  ): Promise<boolean> {
    if (!SUBJECT_TYPES.has(subjectType)) {
      res.status(400).json({ error: 'subject_type must be event or podcast' });
      return true;
    }
    if (!UUID_RE.test(subjectId)) {
      res.status(400).json({ error: 'invalid subject id' });
      return true;
    }
    const asUser = userClient(req);
    if (!asUser) {
      res.status(401).json({ error: 'session required' });
      return true;
    }
    const { data, error } = await asUser.rpc('can_edit_videos_for', {
      p_subject_type: subjectType,
      p_subject_id: subjectId,
    });
    if (error) {
      logger.warn('can_edit_videos_for failed', { subjectType, error: error.message });
      res.status(403).json({ error: 'not permitted for this subject' });
      return true;
    }
    if (data !== true) {
      res.status(403).json({ error: 'not permitted for this subject' });
      return true;
    }
    return false;
  }

  /**
   * May the caller touch THIS video?
   *
   * The distinction that matters, and the one the first version of this file
   * got wrong: denyUnlessAnyGrant answers "do they hold a grant somewhere",
   * which is right for showing the module and wrong for a route that takes an
   * id. Without this, an editor granted event A could read or publish event
   * B's video by passing its uuid. The subject is resolved from the video
   * itself rather than from the request body, because the body is the
   * attacker's half of the conversation.
   */
  async function denyUnlessVideo(req: Request, res: Response, videoId: string): Promise<boolean> {
    if (!UUID_RE.test(videoId)) {
      res.status(400).json({ error: 'invalid video id' });
      return true;
    }
    const asUser = userClient(req);
    if (!asUser) {
      res.status(401).json({ error: 'session required' });
      return true;
    }
    const { data, error } = await asUser.rpc('can_edit_video', { p_video_id: videoId });
    if (error) {
      logger.warn('can_edit_video failed', { videoId, error: error.message });
      res.status(403).json({ error: 'not permitted for this video' });
      return true;
    }
    if (data !== true) {
      res.status(403).json({ error: 'not permitted for this video' });
      return true;
    }
    return false;
  }

  /**
   * Does the unit (agenda entry or episode) belong to a subject the caller
   * holds?
   *
   * Checking the subject id from the body is not enough: the unit id is a
   * second, independent identifier, so an editor could pass their own event
   * and somebody else's talk and attach an upload to it.
   */
  async function denyUnlessUnit(
    req: Request,
    res: Response,
    subjectType: string,
    unitId: string,
  ): Promise<boolean> {
    if (!UUID_RE.test(unitId)) {
      res.status(400).json({ error: 'invalid unit id' });
      return true;
    }
    const asUser = userClient(req);
    if (!asUser) {
      res.status(401).json({ error: 'session required' });
      return true;
    }
    const { data, error } = await asUser.rpc('can_edit_videos_for_unit', {
      p_subject_type: subjectType,
      p_unit_id: unitId,
    });
    if (error || data !== true) {
      if (error) logger.warn('can_edit_videos_for_unit failed', { unitId, error: error.message });
      res.status(403).json({ error: 'that talk or episode is not in your scope' });
      return true;
    }
    return false;
  }

  /** Does the caller hold can_schedule anywhere relevant? (spec §18.1) */
  async function canSchedule(req: Request, videoId: string): Promise<boolean> {
    const uid = await callerId(req);
    if (!uid) return false;
    const asUser = userClient(req);
    const { data: isAdmin } = await asUser.rpc('is_admin');
    if (isAdmin === true) return true;

    // Resolve the subject from the VIDEO. An earlier version took it from the
    // request body, which meant an editor could name a subject they held while
    // acting on a video belonging to another one.
    const owners = await videoOwners(videoId);
    const { data: grants } = await supabase
      .from('video_editor_grants')
      .select('can_schedule, subject_type, subject_id')
      .eq('user_id', uid);
    return (grants ?? []).some(
      (g) =>
        g.can_schedule === true &&
        (g.subject_type === 'all'
          || owners.some((o) => o.type === g.subject_type && o.id === g.subject_id)),
    );
  }

  /**
   * The events or podcasts a video belongs to, resolved through its subjects.
   *
   * Mirrors can_edit_video()'s mapping in SQL: an agenda entry belongs to an
   * event, an episode to a podcast. Service-role reads, because this is used
   * to make an authorisation decision about rows the caller may not see yet.
   */
  async function videoOwners(videoId: string): Promise<Array<{ type: string; id: string }>> {
    const out: Array<{ type: string; id: string }> = [];
    const { data: subs } = await supabase
      .from('video_subjects')
      .select('subject_type, subject_id')
      .eq('video_id', videoId);
    for (const sub of subs ?? []) {
      const t = String(sub.subject_type);
      const id = String(sub.subject_id);
      if (t === 'event') {
        out.push({ type: 'event', id });
      } else if (t === 'agenda_entry' || t === 'talk') {
        const { data } = await supabase
          .from('events_agenda_entries').select('event_uuid').eq('id', id).maybeSingle();
        if (data?.event_uuid) out.push({ type: 'event', id: String(data.event_uuid) });
      } else if (t === 'podcast_episode') {
        const { data } = await supabase
          .from('podcast_episodes').select('podcast_id').eq('id', id).maybeSingle();
        if (data?.podcast_id) out.push({ type: 'podcast', id: String(data.podcast_id) });
      }
    }
    return out;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Step 1-3: what can I work on at all?
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * May the caller see things that belong to no subject yet?
   *
   * Every other list here is scoped by subject, because every row has one. An
   * unassigned video has none, so there is nothing to scope it by, and
   * denyUnlessAnyGrant would let an editor granted one event read the title of
   * every unattached video on the account. So the queue is for admins and
   * holders of an 'all' grant. An event-scoped editor loses nothing: they
   * could not assign anything to a subject they do not hold anyway.
   */
  async function denyUnlessUnrestricted(req: Request, res: Response): Promise<boolean> {
    if (await denyUnlessAnyGrant(req, res)) return true;
    const asUser = userClient(req);
    const { data: isAdmin } = await asUser.rpc('is_admin');
    if (isAdmin === true) return false;

    const uid = await callerId(req);
    const { data: grants } = await supabase
      .from('video_editor_grants')
      .select('subject_type')
      .eq('user_id', uid ?? '00000000-0000-0000-0000-000000000000')
      .eq('subject_type', 'all')
      .limit(1);
    if ((grants ?? []).length > 0) return false;

    res.status(403).json({ error: 'the unassigned queue is for unrestricted editors' });
    return true;
  }

  /** The caller's own grants, so the UI can skip steps it cannot offer. */
  router.get('/scope', async (req: Request, res: Response) => {
    if (await denyUnlessAnyGrant(req, res)) return;
    const uid = await callerId(req);
    const asUser = userClient(req);
    const { data: isAdmin } = await asUser.rpc('is_admin');

    const { data: grants } = await supabase
      .from('video_editor_grants')
      .select('subject_type, subject_id, can_upload, can_schedule')
      .eq('user_id', uid ?? '00000000-0000-0000-0000-000000000000');

    res.json({
      is_admin: isAdmin === true,
      grants: grants ?? [],
      // An admin, or anyone with an 'all' grant, may pick any subject.
      unrestricted: isAdmin === true || (grants ?? []).some((g) => g.subject_type === 'all'),
      uploads_available: ticketsAvailable(),
    });
  });

  /**
   * Step 5: the events or podcasts the caller may edit.
   *
   * An editor with one event sees one event. The filter is applied here rather
   * than in the UI because the UI is not a security boundary.
   */
  router.get('/subjects', async (req: Request, res: Response) => {
    if (await denyUnlessAnyGrant(req, res)) return;
    const subjectType = String(req.query.type ?? '');
    if (!SUBJECT_TYPES.has(subjectType)) {
      return res.status(400).json({ error: 'type must be event or podcast' });
    }

    const uid = await callerId(req);
    const asUser = userClient(req);
    const { data: isAdmin } = await asUser.rpc('is_admin');
    const { data: grants } = await supabase
      .from('video_editor_grants')
      .select('subject_type, subject_id')
      .eq('user_id', uid ?? '00000000-0000-0000-0000-000000000000');
    const unrestricted = isAdmin === true || (grants ?? []).some((g) => g.subject_type === 'all');
    const allowed = new Set(
      (grants ?? []).filter((g) => g.subject_type === subjectType).map((g) => String(g.subject_id)),
    );
    if (!unrestricted && allowed.size === 0) return res.json({ subjects: [] });

    const search = searchTerm(req.query.q);

    if (subjectType === 'event') {
      // Past events only. An editor uploads a recording of something that has
      // already happened, and the brand has ~994 events, most of them not
      // candidates. Events with NO date at all are excluded rather than
      // guessed at — they cannot be shown to be past.
      //
      // The timestamp is generated here, not taken from the request, which is
      // what makes it safe to put inside .or(). Never interpolate a request
      // value into one of these: the commas and parentheses are the filter
      // syntax itself.
      const nowIso = new Date().toISOString();

      // Only events that are set up to work on: an agenda to pick a talk from
      // and speakers attached. Intersected with the caller's grants, so this
      // narrows what an editor sees and never widens it.
      const workable = await workableEventIds(supabase);
      if (workable.size === 0) {
        return res.json({ subjects: [], truncated: false, reason: 'no_event_has_an_agenda' });
      }
      const visible = unrestricted
        ? [...workable]
        : [...workable].filter((id) => allowed.has(id));
      if (visible.length === 0) return res.json({ subjects: [], truncated: false });

      let q = supabase
        .from('events')
        .select('id, event_id, event_title, event_start, event_end')
        .in('id', visible)
        .or(`event_end.lt.${nowIso},and(event_end.is.null,event_start.lt.${nowIso})`)
        .order('event_start', { ascending: false, nullsFirst: false })
        .limit(PAGE);
      if (search) q = q.ilike('event_title', `%${search}%`);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.json({
        subjects: (data ?? []).map((e) => ({
          id: e.id,
          label: e.event_title,
          reference: e.event_id,
          starts_at: e.event_start,
          ends_at: e.event_end,
        })),
        // So the UI can say "showing the 200 most recent" rather than let the
        // editor believe an event is missing when it is just past the page.
        truncated: (data ?? []).length >= PAGE,
      });
    }

    // Podcasts. ALL of them, with no date filter: a podcast is an ongoing
    // thing rather than something that has happened, so "past" is meaningless.
    //
    // The table belongs to another module, so a missing table is "no podcasts"
    // rather than an error: `videos` must install on a brand that has no
    // podcasts module at all.
    let q = supabase.from('podcasts').select('id, name, slug').order('name').limit(PAGE);
    if (!unrestricted) q = q.in('id', [...allowed]);
    if (search) q = q.ilike('name', `%${search}%`);
    const { data, error } = await q;
    if (error) {
      logger.warn('podcast list unavailable', { error: error.message });
      return res.json({ subjects: [], unavailable: 'podcasts module not installed' });
    }
    res.json({
      subjects: (data ?? []).map((p) => ({ id: p.id, label: p.name, reference: p.slug })),
      truncated: (data ?? []).length >= PAGE,
    });
  });

  /**
   * The triage queue: videos belonging to no event and no podcast.
   *
   * Discovery adopts a connected account's whole back catalogue, so this is
   * where several hundred videos land on day one — 555 podcast episodes and
   * 36 YouTube videos on AAIF. Ordered by view count rather than by date,
   * because the ones worth attributing are the ones people watched.
   */
  router.get('/unassigned', async (req: Request, res: Response) => {
    if (await denyUnlessUnrestricted(req, res)) return;
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const asked = typeof req.query.provider === 'string' ? req.query.provider : '';
    if (asked && !PROVIDERS.has(asked)) {
      return res.status(400).json({ error: 'unknown provider' });
    }
    const provider = asked;
    const search = searchTerm(req.query.q);

    let q = supabase
      .from('videos_unassigned')
      .select('id, provider, title, url, thumbnail_url, duration_seconds, published_at, channel_title, kind, connection_label, latest_views, views_as_of', { count: 'exact' })
      .order('latest_views', { ascending: false, nullsFirst: false })
      .order('published_at', { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1);
    if (provider) q = q.eq('provider', provider);
    if (search) q = q.ilike('title', `%${search}%`);

    const { data, error, count } = await q;
    if (error) return res.status(500).json({ error: error.message });
    // Both of these are rendered as a URL by the admin, and both come from a
    // third party. Anything that is not http(s) becomes null here.
    const videos = (data ?? []).map((v: Record<string, unknown>) => ({
      ...v,
      url: safeLink(v.url),
      thumbnail_url: safeLink(v.thumbnail_url),
    }));
    res.json({ videos, total: count ?? 0, limit, offset });
  });

  /**
   * How many are waiting, per provider, for the filter buttons.
   *
   * Counted with head requests rather than by reading the provider column of
   * every row and tallying it. Reading would need a row cap, and a cap on a
   * count silently under-reports the moment the queue passes it — which is
   * exactly the number an operator uses to decide there is nothing left to do.
   * One count per known provider is bounded and exact.
   */
  router.get('/unassigned/summary', async (req: Request, res: Response) => {
    if (await denyUnlessUnrestricted(req, res)) return;

    const counted = await Promise.all(
      [...PROVIDERS].map(async (p) => {
        const { count, error } = await supabase
          .from('videos_unassigned')
          .select('id', { count: 'exact', head: true })
          .eq('provider', p);
        return { provider: p, count: error ? null : (count ?? 0) };
      }),
    );

    const byProvider: Record<string, number> = {};
    let total = 0;
    const unreadable: string[] = [];
    for (const c of counted) {
      if (c.count === null) { unreadable.push(c.provider); continue; }
      if (c.count > 0) byProvider[c.provider] = c.count;
      total += c.count;
    }
    // Say so rather than presenting a short total as the whole picture.
    res.json({
      total,
      by_provider: byProvider,
      ...(unreadable.length > 0 ? { unreadable } : {}),
    });
  });

  /**
   * Attach one video to an event, podcast, agenda entry or episode.
   *
   * Goes through assign_video_subject() rather than inserting directly, so
   * the two rules stay in one place: one subject per video, and the subject
   * has to exist.
   */
  router.post('/unassigned/:videoId/assign', async (req: Request, res: Response) => {
    const videoId = String(req.params.videoId ?? '');
    if (!UUID_RE.test(videoId)) return res.status(400).json({ error: 'invalid video id' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjectType = String(body.subject_type ?? '');
    const subjectId = String(body.subject_id ?? '');
    if (!UUID_RE.test(subjectId)) return res.status(400).json({ error: 'subject_id must be a uuid' });
    if (!['event', 'podcast', 'agenda_entry', 'podcast_episode'].includes(subjectType)) {
      return res.status(400).json({ error: 'subject_type must be event, podcast, agenda_entry or podcast_episode' });
    }

    // The caller must be allowed to edit THAT subject, not merely hold some
    // grant. Which check depends on what kind of thing they named, and the
    // two vocabularies do not line up: assign takes four subject types, while
    // can_edit_videos_for_unit() takes the OWNER type ('event' or 'podcast')
    // plus a unit id. Passing the assign vocabulary straight through returns
    // false for 'agenda_entry' and looks an event uuid up in
    // events_agenda_entries for 'event', so every non-admin assign would 403
    // — invisible while testing as an admin, because is_admin() returns true
    // before either lookup.
    const denied =
      subjectType === 'agenda_entry'
        ? await denyUnlessUnit(req, res, 'event', subjectId)
        : subjectType === 'podcast_episode'
          ? await denyUnlessUnit(req, res, 'podcast', subjectId)
          : await denyUnlessSubject(req, res, subjectType, subjectId);
    if (denied) return;

    // The video must actually be unassigned.
    //
    // Authorising the DESTINATION is not enough on its own. A video id is
    // public — public-routes.ts returns `id` in its unauthenticated
    // projection — and assign_video_subject() deletes any existing link
    // before writing the new one. So without this check, an editor granted
    // one event could take the id of a video belonging to somebody else's
    // event, assign it to their own, and detach it from the subject they hold
    // no grant over. Every check in the route would pass, because every check
    // was about where the video was going rather than where it already was.
    //
    // Requiring no existing link is both the narrower rule and the one this
    // route's name already promises. Moving an assigned video is a different
    // operation and belongs to the editor workspace, where the caller is
    // authorised against the video itself.
    const { data: existing, error: existingErr } = await supabase
      .from('video_subjects')
      .select('subject_type')
      .eq('video_id', videoId)
      .limit(1);
    if (existingErr) {
      logger.warn('could not read current subject', { video: videoId, error: existingErr.message });
      return res.status(500).json({ error: 'could not check the video' });
    }
    if ((existing ?? []).length > 0) {
      // Deliberately says nothing about WHICH subject holds it.
      return res.status(409).json({ error: 'that video already belongs to something' });
    }

    const { data, error } = await supabase.rpc('assign_video_subject', {
      p_video_id: videoId,
      p_subject_type: subjectType,
      p_subject_id: subjectId,
      p_source: 'manual',
    });
    if (error) return res.status(400).json({ error: error.message });
    logger.info('video assigned', { video: videoId, subjectType, subjectId });
    res.json(data ?? { video_id: videoId });
  });

  /**
   * Step 6: the units of work within a subject.
   *
   * For an event that is its agenda sessions, because the agenda entry is the
   * sturdier anchor: events_agenda_entries.event_uuid is NOT NULL with a hard
   * FK, while events_talks.event_uuid is nullable under its scope constraint.
   * For a podcast it is the episodes.
   */
  router.get('/subjects/:subjectType/:subjectId/units', async (req: Request, res: Response) => {
    const subjectType = String(req.params.subjectType ?? '');
    const subjectId = String(req.params.subjectId ?? '');
    if (await denyUnlessSubject(req, res, subjectType, subjectId)) return;

    if (subjectType === 'event') {
      const { data: entries, error } = await supabase
        .from('events_agenda_entries')
        .select('id, title, start_time, end_time, entry_type, talk_id')
        .eq('event_uuid', subjectId)
        .eq('entry_type', 'session')
        .order('start_time', { ascending: true, nullsFirst: false })
        .limit(500);
      if (error) {
        logger.warn('agenda unavailable', { error: error.message });
        return res.json({ units: [], unavailable: 'event-agenda module not installed' });
      }

      // How many videos each unit already has, so the editor can see at a
      // glance what is still outstanding. One batched query, not N.
      const ids = (entries ?? []).map((e) => e.id);
      const counts = new Map<string, { full: number; short: number }>();
      if (ids.length) {
        const { data: subs } = await supabase
          .from('video_subjects')
          .select('subject_id, videos!inner(kind)')
          .eq('subject_type', 'agenda_entry')
          .in('subject_id', ids);
        for (const s of subs ?? []) {
          const k = String(s.subject_id);
          const cur = counts.get(k) ?? { full: 0, short: 0 };
          if (s.videos?.kind === 'short') cur.short += 1;
          else cur.full += 1;
          counts.set(k, cur);
        }
      }

      return res.json({
        units: (entries ?? []).map((e) => ({
          id: e.id,
          label: e.title,
          starts_at: e.start_time,
          talk_id: e.talk_id ?? null,
          videos: counts.get(String(e.id)) ?? { full: 0, short: 0 },
        })),
      });
    }

    const { data: eps, error } = await supabase
      .from('podcast_episodes')
      .select('id, title, episode_number, season, publish_date')
      .eq('podcast_id', subjectId)
      .order('publish_date', { ascending: false, nullsFirst: false })
      .limit(500);
    if (error) {
      logger.warn('episodes unavailable', { error: error.message });
      return res.json({ units: [], unavailable: 'podcasts module not installed' });
    }
    res.json({
      units: (eps ?? []).map((e) => ({
        id: e.id,
        label: e.episode_number ? `${e.episode_number}. ${e.title}` : e.title,
        starts_at: e.publish_date,
        videos: { full: 0, short: 0 },
      })),
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Step 7: upload
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Mint one signed upload URL per file.
   *
   * Creates the `videos` row (if this is a new deliverable), the asset row in
   * `uploading`, and the session, then signs a ticket describing exactly what
   * was authorised. The browser PUTs to the returned URL.
   */
  router.post('/uploads/mint', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjectType = String(body.subject_type ?? '');
    const subjectId = String(body.subject_id ?? '');
    if (await denyUnlessSubject(req, res, subjectType, subjectId)) return;
    if (!ticketsAvailable()) {
      return res.status(503).json({ error: 'uploads unavailable: SUPABASE_JWT_SECRET is not configured' });
    }

    const unitId = String(body.unit_id ?? '');
    // The unit is a SECOND identifier. Holding the subject does not imply
    // holding this talk, so it is checked on its own.
    if (await denyUnlessUnit(req, res, subjectType, unitId)) return;

    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0) return res.status(400).json({ error: 'files is required' });
    if (files.length > 20) return res.status(400).json({ error: 'at most 20 files per mint' });

    const uid = await callerId(req);
    // The unit is an agenda entry for an event, an episode for a podcast.
    const unitSubjectType = subjectType === 'event' ? 'agenda_entry' : 'podcast_episode';

    const out: Array<Record<string, unknown>> = [];
    for (const raw of files) {
      const f = (raw ?? {}) as Record<string, unknown>;
      const kind = String(f.kind ?? 'master') as UploadKind;
      const reason = rejectUpload({
        kind,
        mimeType: String(f.mime_type ?? ''),
        bytes: Number(f.bytes),
        filename: String(f.filename ?? ''),
      });
      if (reason) {
        out.push({ filename: String(f.filename ?? ''), status: 'rejected', reason });
        continue;
      }

      // A master attaches to the unit's own video; a short is its own video
      // row derived from it, because a short publishes separately and carries
      // its own numbers (spec §17).
      const isShort = kind === 'short';
      let videoId: string | null = null;

      // Reuse the unit's existing full video when one exists, so a re-upload
      // supersedes rather than forking.
      const { data: existing } = await supabase
        .from('video_subjects')
        .select('video_id, videos!inner(id, kind)')
        .eq('subject_type', unitSubjectType)
        .eq('subject_id', unitId)
        .limit(50);
      const full = (existing ?? []).find((s) => s.videos?.kind === 'full');

      if (!isShort && full) {
        videoId = String(full.video_id);
      } else {
        const title = String(f.title ?? '').trim() || String(f.filename ?? 'Untitled');
        const ins = await supabase
          .from('videos')
          .insert({
            provider: 'gatewaze',
            // Unique per row and stable; the real external id arrives at
            // publish time and lands on video_publications instead.
            provider_video_id: `pending-${globalThis.crypto.randomUUID()}`,
            url: '',
            title: title.slice(0, 300),
            kind: isShort ? 'short' : 'full',
            status: 'draft',
            publish_state: 'draft',
            visibility: 'private',
            is_external: false,
            source: 'editor-upload',
            ...(isShort && full ? { derived_from_video_id: String(full.video_id) } : {}),
          })
          .select('id')
          .single();
        if (ins.error) {
          out.push({ filename: String(f.filename ?? ''), status: 'failed', reason: ins.error.message });
          continue;
        }
        videoId = String(ins.data.id);

        const link = await supabase.from('video_subjects').insert({
          video_id: videoId,
          subject_type: unitSubjectType,
          subject_id: unitId,
          source: 'editor',
        });
        if (link.error) logger.warn('could not link video to unit', { error: link.error.message });
      }

      // Masters and shorts go to the S3 store when one is configured, so the
      // row records both the bucket and which API it belongs to.
      const store = storeForNew(supabase, kind);
      const bucket = store.bucket;
      const assetIns = await supabase
        .from('video_assets')
        .insert({
          video_id: videoId,
          kind,
          storage_bucket: bucket,
          storage_provider: store.provider,
          // Rewritten below once the asset id exists; a path must be unique
          // per asset and the id is what makes it so.
          storage_path: 'pending',
          filename: String(f.filename ?? '').slice(0, 255),
          mime_type: String(f.mime_type ?? ''),
          bytes: Number(f.bytes),
          state: 'uploading',
          source: 'upload',
          uploaded_by: uid,
        })
        .select('id')
        .single();
      if (assetIns.error) {
        out.push({ filename: String(f.filename ?? ''), status: 'failed', reason: assetIns.error.message });
        continue;
      }
      const assetId = String(assetIns.data.id);
      const storagePath = buildStoragePath({
        subjectType: unitSubjectType,
        subjectId: unitId,
        assetId,
        filename: String(f.filename ?? ''),
      });
      await supabase.from('video_assets').update({ storage_path: storagePath }).eq('id', assetId);

      // An upload from the command line gets a longer-lived URL, so a large
      // file never has to go through a browser tab. Only when asked for: the
      // URL is a bearer for the object, and twelve hours of it should not be
      // handed to every browser upload that never uses it. Same object, same
      // pinned type and length; `check` closes it, and the session lives as
      // long as the URL so the reaper does not fail the row mid-upload.
      // Accepted residual risk: until the URL expires, whoever holds it can
      // PUT another file of the same type and length over the object, so the
      // curl line is shown once and never stored.
      const viaCli = f.cli_upload === true && store.provider === 's3';
      const ttl = viaCli ? CLI_UPLOAD_TTL_SECONDS : TICKET_TTL_SECONDS;
      let uploadUrl: string;
      try {
        uploadUrl = await store.signUpload(storagePath, String(f.mime_type ?? ''), ttl, Number(f.bytes));
      } catch (err) {
        // The detail names buckets and endpoints; it goes to the log and the
        // row, not to a third-party editor.
        const msg = String((err as Error)?.message ?? err);
        logger.warn('could not sign upload', { asset: assetId, error: msg });
        await supabase.from('video_assets')
          .update({ state: 'failed', error: `could not sign upload: ${msg}` })
          .eq('id', assetId);
        out.push({ filename: String(f.filename ?? ''), status: 'failed', reason: 'could not sign the upload' });
        continue;
      }

      const sessionIns = await supabase
        .from('video_upload_sessions')
        .insert({
          asset_id: assetId,
          storage_bucket: bucket,
          storage_provider: store.provider,
          storage_path: storagePath,
          expected_bytes: Number(f.bytes),
          expected_mime: String(f.mime_type ?? ''),
          created_by: uid,
          expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
        })
        .select('id')
        .single();
      if (sessionIns.error) {
        out.push({ filename: String(f.filename ?? ''), status: 'failed', reason: sessionIns.error.message });
        continue;
      }

      out.push({
        filename: String(f.filename ?? ''),
        status: 'ready',
        kind,
        video_id: videoId,
        asset_id: assetId,
        storage_path: storagePath,
        // The browser PUTs here. The store has already rewritten a Supabase
        // URL to the public host; an S3 URL is public as signed.
        upload_url: uploadUrl,
        // The browser must send exactly this Content-Type: on S3 it is part of
        // the signature, and on both stores it is what `complete` enforces.
        upload_headers: { 'Content-Type': String(f.mime_type ?? '') },
        ...(viaCli ? {
          cli_upload_command: cliUploadCommand(uploadUrl, String(f.mime_type ?? ''), String(f.filename ?? '')),
          cli_upload_expires_in: CLI_UPLOAD_TTL_SECONDS,
        } : {}),
        ticket: mintTicket({
          asset_id: assetId,
          session_id: String(sessionIns.data.id),
          storage_bucket: bucket,
          storage_provider: store.provider,
          storage_path: storagePath,
          mime_type: String(f.mime_type ?? ''),
          max_bytes: MAX_BYTES[kind],
          user_id: uid ?? '',
        }),
      });
    }

    res.status(200).json({ files: out });
  });

  /**
   * Finalise an upload.
   *
   * Trusts the ticket, not the body. Then HEADs the stored object to learn its
   * real size and content type, because on a signed PUT the client chose both
   * and the mint-time claim has to be enforced somewhere. Fails closed on a
   * missing content type.
   */
  router.post('/uploads/complete', async (req: Request, res: Response) => {
    if (await denyUnlessAnyGrant(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const verified = verifyTicket(body.ticket);
    if (!verified.ok) {
      const status = verified.error === 'unavailable' ? 503 : 400;
      return res.status(status).json({ error: `upload ticket ${verified.error}` });
    }
    const t = verified.payload;

    // The ticket is bound to the user who minted it.
    const uid = await callerId(req);
    if (!uid || uid !== t.user_id) {
      return res.status(403).json({ error: 'ticket was not minted for this user' });
    }

    // Idempotent: a retried complete returns the same answer.
    const { data: asset } = await supabase
      .from('video_assets')
      .select('id, video_id, state, kind, bytes, mime_type')
      .eq('id', t.asset_id)
      .maybeSingle();
    if (!asset) return res.status(404).json({ error: 'asset not found' });
    if (asset.state === 'ready') {
      return res.json({ status: 'already_complete', asset_id: asset.id, video_id: asset.video_id });
    }
    // Only an upload in flight can be completed. A failed or superseded asset
    // stays that way: an S3 presigned PUT can be replayed until it expires,
    // and this is what stops a second PUT reviving a row that was closed.
    if (asset.state !== 'uploading') {
      return res.status(409).json({ error: `asset is ${asset.state}` });
    }

    // The ticket says which store signed the upload; a pre-014 ticket is
    // Supabase. storeFor refuses an S3 bucket other than the configured one.
    let store;
    try {
      store = storeFor(supabase, { storage_provider: t.storage_provider ?? 'supabase', storage_bucket: t.storage_bucket });
    } catch (err) {
      logger.warn('could not resolve the asset store', { asset: t.asset_id, error: String((err as Error)?.message ?? err) });
      return res.status(500).json({ error: 'storage is not configured for this asset' });
    }
    const outcome = await finishUpload({
      store, assetId: String(asset.id), videoId: String(asset.video_id), kind: String(asset.kind),
      storagePath: t.storage_path, maxBytes: t.max_bytes, mimeType: t.mime_type, sessionId: t.session_id, hints: body,
    });
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ status: 'complete', asset_id: asset.id, video_id: asset.video_id, bytes: outcome.bytes });
  });

  /**
   * Close an upload that was made from the command line, where no ticket
   * survives: the editor pasted the curl line, the bytes landed, and now
   * the row has to be told. The ticket's bindings are re-derived from the
   * rows the mint wrote instead: the asset must be an editor upload, still
   * `uploading`, minted by this caller, with its session still open. An
   * import or studio row in flight is not closable this way, so a mismatch
   * here cannot delete a worker's object; and a closed row stays closed, so
   * a replayed PUT cannot revive it.
   */
  router.post('/uploads/:assetId/check', async (req: Request, res: Response) => {
    if (await denyUnlessAnyGrant(req, res)) return;
    const assetId = String(req.params.assetId ?? '');
    if (!UUID_RE.test(assetId)) return res.status(400).json({ error: 'invalid asset id' });
    const { data: asset } = await supabase
      .from('video_assets')
      .select('id, video_id, state, kind, mime_type, source, uploaded_by, storage_provider, storage_bucket, storage_path')
      .eq('id', assetId)
      .maybeSingle();
    if (!asset) return res.status(404).json({ error: 'asset not found' });
    if (await denyUnlessVideo(req, res, String(asset.video_id))) return;
    if (asset.state === 'ready') {
      return res.json({ status: 'already_complete', asset_id: asset.id, video_id: asset.video_id });
    }
    if (asset.state !== 'uploading') return res.status(409).json({ error: `asset is ${asset.state}` });
    if (asset.source !== 'upload') return res.status(409).json({ error: 'only an editor upload can be checked' });
    const uid = await callerId(req);
    if (!uid || String(asset.uploaded_by ?? '') !== uid) {
      return res.status(403).json({ error: 'this upload was not minted by you' });
    }
    if (!(asset.kind in MAX_BYTES)) return res.status(409).json({ error: 'unknown asset kind' });
    const { data: session } = await supabase
      .from('video_upload_sessions').select('id, expires_at').eq('asset_id', assetId).eq('state', 'open').limit(1).maybeSingle();
    if (!session) return res.status(409).json({ error: 'the upload session has expired; mint the upload again' });
    let store;
    try {
      store = storeFor(supabase, asset);
    } catch (err) {
      logger.warn('could not resolve the asset store', { asset: assetId, error: String((err as Error)?.message ?? err) });
      return res.status(500).json({ error: 'storage is not configured for this asset' });
    }
    const outcome = await finishUpload({
      store, assetId, videoId: String(asset.video_id), kind: String(asset.kind), storagePath: String(asset.storage_path),
      maxBytes: MAX_BYTES[asset.kind as UploadKind], mimeType: String(asset.mime_type ?? ''), sessionId: String(session.id),
      hints: (req.body ?? {}) as Record<string, unknown>, notFoundIsSoft: true,
    });
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ status: 'complete', asset_id: assetId, video_id: asset.video_id, bytes: outcome.bytes });
  });

  /**
   * The checks every upload passes before its row becomes ready: the object
   * is there, it is not over the cap, and its stored Content-Type is the one
   * declared at mint. Shared by the ticketed `complete` and the ticketless
   * `check`, so the two cannot drift.
   */
  async function finishUpload(args: {
    store; assetId: string; videoId: string; kind: string; storagePath: string; maxBytes: number; mimeType: string;
    sessionId: string | null; hints: Record<string, unknown>;
    /** A missing object is "not yet", not a failure: the editor may still be uploading. */
    notFoundIsSoft?: boolean;
  }): Promise<{ ok: true; bytes: number } | { ok: false; status: number; error: string }> {
    // Every write below is guarded by the state it expects to find, so two
    // racing closes, or a close racing the reaper, cannot flip a failed row
    // back to ready.
    const fail = async (error: string) => {
      await supabase.from('video_assets').update({ state: 'failed', error }).eq('id', args.assetId).eq('state', 'uploading');
    };

    const head = await args.store.head(args.storagePath);
    if (!head.ok) {
      if (args.notFoundIsSoft) return { ok: false, status: 409, error: 'nothing has arrived in storage yet' };
      await fail('stored object not found');
      return { ok: false, status: 409, error: 'stored object not found — did the upload finish?' };
    }

    // 10% tolerance mirrors event-media's completion check: storage can
    // report a slightly different length than the client measured.
    if (head.bytes > args.maxBytes * 1.1) {
      await args.store.remove(args.storagePath);
      await fail('file too large');
      return { ok: false, status: 413, error: 'file_too_large' };
    }

    // The client controls Content-Type on a signed PUT. This is where the
    // mint-time claim is enforced. Fail CLOSED on an empty stored type.
    if (!head.contentType || head.contentType.toLowerCase() !== args.mimeType.toLowerCase()) {
      await args.store.remove(args.storagePath);
      await fail(`mime mismatch: stored ${head.contentType || 'none'}`);
      return { ok: false, status: 415, error: 'mime_mismatch' };
    }

    // Duration and dimensions are client-reported hints, bounded and stored
    // as given; the studio probes the real values when it runs.
    const duration = posInt(args.hints.duration_seconds, 86_400);
    const width = posInt(args.hints.width, 16_384);
    const height = posInt(args.hints.height, 16_384);

    // Supersede a previous ready master so the one-ready-master index holds.
    if (args.kind === 'master') {
      await supabase.from('video_assets').update({ state: 'superseded' })
        .eq('video_id', args.videoId).eq('kind', 'master').eq('state', 'ready');
    }

    const upd = await supabase
      .from('video_assets')
      .update({
        state: 'ready',
        bytes: head.bytes,
        mime_type: head.contentType,
        error: null,
        ...(duration !== null ? { duration_seconds: duration } : {}),
        ...(width !== null ? { width } : {}),
        ...(height !== null ? { height } : {}),
      })
      .eq('id', args.assetId)
      .eq('state', 'uploading')
      .select('id');
    if (upd.error) return { ok: false, status: 500, error: upd.error.message };
    if (!(upd.data ?? []).length) return { ok: false, status: 409, error: 'the upload was closed by something else first' };

    if (args.sessionId) {
      await supabase.from('video_upload_sessions')
        .update({ state: 'completed', completed_at: new Date().toISOString() }).eq('id', args.sessionId);
    }
    logger.info('video asset uploaded', { asset: args.assetId, kind: args.kind, bytes: head.bytes });
    return { ok: true, bytes: head.bytes };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // What is already there, and the generated copy
  // ───────────────────────────────────────────────────────────────────────────

  /** Every video attached to one unit, with its assets and publications. */
  router.get('/subjects/:subjectType/:subjectId/units/:unitId/videos', async (req: Request, res: Response) => {
    const subjectType = String(req.params.subjectType ?? '');
    const subjectId = String(req.params.subjectId ?? '');
    if (await denyUnlessSubject(req, res, subjectType, subjectId)) return;
    const unitId = String(req.params.unitId ?? '');
    if (await denyUnlessUnit(req, res, subjectType, unitId)) return;

    const unitSubjectType = subjectType === 'event' ? 'agenda_entry' : 'podcast_episode';
    const { data: subs, error } = await supabase
      .from('video_subjects')
      .select('video_id')
      .eq('subject_type', unitSubjectType)
      .eq('subject_id', unitId);
    if (error) return res.status(500).json({ error: error.message });
    const ids = [...new Set((subs ?? []).map((s) => String(s.video_id)))];
    if (ids.length === 0) return res.json({ videos: [] });

    const { data: videos } = await supabase
      .from('videos')
      .select('id, title, kind, derived_from_video_id, status, visibility, duration_seconds, created_at')
      .in('id', ids)
      .order('created_at', { ascending: true });
    const { data: assets } = await supabase
      .from('video_assets')
      .select('id, video_id, kind, state, bytes, mime_type, filename, duration_seconds, created_at')
      .in('video_id', ids)
      .order('created_at', { ascending: false });
    const { data: pubs } = await supabase
      .from('video_publications')
      .select('id, video_id, platform, state, scheduled_for, requested_visibility, external_url, last_error, published_at')
      .in('video_id', ids);

    res.json({
      videos: (videos ?? []).map((v) => ({
        ...v,
        assets: (assets ?? []).filter((a) => a.video_id === v.id),
        publications: (pubs ?? []).filter((p) => p.video_id === v.id),
      })),
    });
  });

  /**
   * The drafted titles and copy for a video (spec §18.3).
   *
   * Deterministic, assembled from the programme's own fields. Returned rather
   * than stored, so the editor sees a fresh draft until they save an edit.
   */
  router.get('/videos/:videoId/copy', async (req: Request, res: Response) => {
    const videoId = String(req.params.videoId ?? '');
    if (await denyUnlessVideo(req, res, videoId)) return;

    const { data: video } = await supabase
      .from('videos')
      .select('id, title, kind')
      .eq('id', videoId)
      .maybeSingle();
    if (!video) return res.status(404).json({ error: 'video not found' });

    const context = await loadCopyContext(videoId, video);
    const platforms = Array.isArray(req.query.platforms)
      ? (req.query.platforms as string[])
      : String(req.query.platforms ?? 'youtube').split(',').map((s) => s.trim()).filter(Boolean);

    res.json({ copy: generateCopy(context, platforms.length ? platforms : ['youtube']), context });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scheduling
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Schedule a publication, or publish now.
   *
   * `scheduled_for` omitted means now. Visibility mirrors the platforms'
   * vocabulary and defaults to private, so nothing reaches an audience by
   * accident (spec §19).
   */
  router.post('/videos/:videoId/publications', async (req: Request, res: Response) => {
    if (await denyUnlessAnyGrant(req, res)) return;
    const videoId = String(req.params.videoId ?? '');
    // Scoped by the video, NOT by the subject in the body: naming a subject
    // you hold while acting on another one's video is the attack this closes.
    if (await denyUnlessVideo(req, res, videoId)) return;
    if (!(await canSchedule(req, videoId))) {
      return res.status(403).json({ error: 'your access allows uploading but not scheduling' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    const platform = String(body.platform ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_]{2,32}$/.test(platform)) {
      return res.status(400).json({ error: 'platform must be a short lowercase key' });
    }
    const visibility = String(body.requested_visibility ?? 'private');
    if (!VISIBILITIES.has(visibility)) {
      return res.status(400).json({ error: 'requested_visibility must be public, unlisted or private' });
    }

    // A ready master is the precondition for publishing anything.
    const { data: ready } = await supabase
      .from('video_assets')
      .select('id')
      .eq('video_id', videoId)
      .in('kind', ['master', 'short'])
      .eq('state', 'ready')
      .limit(1);
    if (!ready?.length) {
      return res.status(409).json({ error: 'no uploaded file for this video yet' });
    }

    let scheduledFor: string | null = null;
    if (body.scheduled_for != null && body.scheduled_for !== '') {
      const t = Date.parse(String(body.scheduled_for));
      if (!Number.isFinite(t)) return res.status(400).json({ error: 'scheduled_for is not a date' });
      // A schedule in the past is almost always a timezone mistake rather than
      // an intention, so it is refused rather than fired immediately.
      if (t < Date.now() - 60_000) {
        return res.status(400).json({ error: 'scheduled_for is in the past' });
      }
      scheduledFor = new Date(t).toISOString();
    }

    const uid = await callerId(req);
    const ins = await supabase
      .from('video_publications')
      .insert({
        video_id: videoId,
        platform,
        state: scheduledFor ? 'scheduled' : 'queued',
        scheduled_for: scheduledFor,
        requested_visibility: visibility,
        requested: {
          title: typeof body.title === 'string' ? body.title.slice(0, 300) : null,
          description: typeof body.description === 'string' ? body.description.slice(0, 5000) : null,
        },
        requested_by: uid,
      })
      .select('*')
      .single();
    if (ins.error) return res.status(500).json({ error: ins.error.message });

    logger.info('video publication created', {
      video: videoId, platform, state: ins.data.state, scheduled_for: scheduledFor,
    });
    res.status(201).json({ publication: ins.data });
  });

  /** Reschedule or cancel, while it is still ours to change (spec §19). */
  router.patch('/publications/:id', async (req: Request, res: Response) => {
    if (await denyUnlessAnyGrant(req, res)) return;
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'invalid publication id' });

    const { data: pub } = await supabase
      .from('video_publications')
      .select('id, state, video_id')
      .eq('id', id)
      .maybeSingle();
    if (!pub) return res.status(404).json({ error: 'publication not found' });
    // Scope by the publication's own video. Without this, one grant anywhere
    // let an editor reschedule or cancel any publication in the system.
    if (await denyUnlessVideo(req, res, String(pub.video_id))) return;

    // After queued the bytes are in flight and the platform decides.
    if (!['draft', 'scheduled'].includes(pub.state)) {
      return res.status(409).json({ error: `cannot change a publication that is ${pub.state}` });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (body.cancel === true) {
      patch.state = 'draft';
      patch.scheduled_for = null;
    } else if (body.scheduled_for !== undefined) {
      if (body.scheduled_for === null || body.scheduled_for === '') {
        patch.state = 'queued';
        patch.scheduled_for = null;
      } else {
        const t = Date.parse(String(body.scheduled_for));
        if (!Number.isFinite(t)) return res.status(400).json({ error: 'scheduled_for is not a date' });
        if (t < Date.now() - 60_000) return res.status(400).json({ error: 'scheduled_for is in the past' });
        patch.state = 'scheduled';
        patch.scheduled_for = new Date(t).toISOString();
      }
    }
    if (typeof body.requested_visibility === 'string') {
      if (!VISIBILITIES.has(body.requested_visibility)) {
        return res.status(400).json({ error: 'invalid requested_visibility' });
      }
      patch.requested_visibility = body.requested_visibility;
    }

    const upd = await supabase.from('video_publications').update(patch).eq('id', id).select('*').single();
    if (upd.error) return res.status(500).json({ error: upd.error.message });
    res.json({ publication: upd.data });
  });

  /** A time-limited URL to watch an unpublished master in the private bucket. */
  router.get('/assets/:assetId/playback', async (req: Request, res: Response) => {
    if (await denyUnlessAnyGrant(req, res)) return;
    const assetId = String(req.params.assetId ?? '');
    if (!UUID_RE.test(assetId)) return res.status(400).json({ error: 'invalid asset id' });

    const { data: asset } = await supabase
      .from('video_assets')
      .select('video_id, storage_bucket, storage_provider, storage_path, state')
      .eq('id', assetId)
      .maybeSingle();
    if (!asset || asset.state !== 'ready') return res.status(404).json({ error: 'no playable asset' });
    // This hands out an hour-long signed URL to an unpublished master, so it
    // is the single most important place to scope by the owning subject.
    if (await denyUnlessVideo(req, res, String(asset.video_id))) return;

    try {
      const url = await storeFor(supabase, asset).signRead(asset.storage_path, 3600);
      res.json({ url, expires_in: 3600 });
    } catch (err) {
      logger.warn('could not sign playback', { asset: assetId, error: String((err as Error)?.message ?? err) });
      res.status(500).json({ error: 'could not sign a playback URL' });
    }
  });

  // ── The studio: analysis, selection, approval ──────────────────────────────
  mountStudioRoutes(router, { supabase, denyUnlessVideo, callerId, logger, ...(enqueueJob ? { enqueueJob } : {}) });

  // ── helpers ────────────────────────────────────────────────────────────────

  /** A bounded positive integer from request JSON, or null. */
  function posInt(v: unknown, max: number): number | null {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(Math.round(n), max);
  }

  /**
   * The authoritative fields the copy generator needs.
   *
   * Read from the programme where there is one, because that is where the
   * conference itself spelled the names, roles and companies. Every read is
   * best-effort: a brand with no event-agenda module still gets a title.
   */
  async function loadCopyContext(videoId: string, video: Record<string, unknown>) {
    const ctx: Record<string, unknown> = {
      talkTitle: String(video.title ?? ''),
      kind: String(video.kind ?? 'full'),
      speakers: [],
      eventName: null,
      worthNoting: null,
      quote: null,
      url: null,
    };
    try {
      const { data: sub } = await supabase
        .from('video_subjects')
        .select('subject_type, subject_id')
        .eq('video_id', videoId)
        .in('subject_type', ['agenda_entry', 'podcast_episode'])
        .limit(1)
        .maybeSingle();
      if (!sub) return ctx;

      if (sub.subject_type === 'agenda_entry') {
        const { data: entry } = await supabase
          .from('events_agenda_entries')
          .select('title, talk_id, event_uuid')
          .eq('id', sub.subject_id)
          .maybeSingle();
        if (entry?.title) ctx.talkTitle = entry.title;
        if (entry?.event_uuid) {
          const { data: ev } = await supabase
            .from('events').select('event_title').eq('id', entry.event_uuid).maybeSingle();
          ctx.eventName = ev?.event_title ?? null;
        }
        if (entry?.talk_id) {
          const { data: talk } = await supabase
            .from('events_talks_with_speakers')
            .select('speakers')
            .eq('id', entry.talk_id)
            .maybeSingle();
          ctx.speakers = (Array.isArray(talk?.speakers) ? talk.speakers : [])
            .map((s) => ({ name: s?.full_name, role: s?.job_title, company: s?.company }))
            .filter((s) => s.name);
        }
      } else {
        const { data: ep } = await supabase
          .from('podcast_episodes')
          .select('title, description, podcast_id')
          .eq('id', sub.subject_id)
          .maybeSingle();
        if (ep?.title) ctx.talkTitle = ep.title;
        ctx.worthNoting = ep?.description ?? null;
        if (ep?.podcast_id) {
          const { data: pod } = await supabase
            .from('podcasts').select('name').eq('id', ep.podcast_id).maybeSingle();
          ctx.eventName = pod?.name ?? null;
        }
      }
    } catch {
      /* best effort by design */
    }
    return ctx;
  }
}
