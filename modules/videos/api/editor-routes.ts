// @ts-nocheck — supabase-js + express are resolved at module-host install time.

/**
 * The video editor's API (spec §16.2, §18).
 *
 * Mounted under /api/modules/videos/editor/*, behind the platform's JWT
 * prefix. Every handler authorises as the CALLER via can_edit_videos_for()
 * before touching anything with the service role.
 *
 * That split is the whole security model and it is worth stating plainly: the
 * JWT prefix proves only that somebody is signed in. A third-party video
 * editor is signed in. Without the per-subject check, an editor granted one
 * event could read and write every other event's videos by guessing a uuid.
 *
 * Uploads never pass through here. The mint step signs a ticket describing the
 * upload it authorised; the browser PUTs the bytes straight to storage with a
 * signed URL; the complete step verifies the ticket and the stored object. The
 * API container never sees a gigabyte.
 */

import type { Request, Response, Router } from 'express';
import { rejectUpload, buildStoragePath, bucketFor, MAX_BYTES, allowedMimes, type UploadKind } from '../lib/upload-rules.js';
import { mintTicket, verifyTicket, ticketsAvailable, TICKET_TTL_SECONDS } from '../lib/upload-tickets.js';
import { generateCopy } from '../lib/titles.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Subject types an editor may work against, per spec §16.2 step 4. */
const SUBJECT_TYPES = new Set(['event', 'podcast']);

/** Visibility values, mirroring the platforms' own vocabulary (spec §19). */
const VISIBILITIES = new Set(['public', 'unlisted', 'private']);

/** How many rows any list endpoint will return. */
const PAGE = 200;

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

  /** Does the caller hold can_schedule anywhere relevant? (spec §18.1) */
  async function canSchedule(req: Request, subjectType: string, subjectId: string): Promise<boolean> {
    const uid = await callerId(req);
    if (!uid) return false;
    // Admins always may. Checked via the caller's own client so is_admin()
    // sees their session.
    const asUser = userClient(req);
    const { data: isAdmin } = await asUser.rpc('is_admin');
    if (isAdmin === true) return true;
    const { data } = await supabase
      .from('video_editor_grants')
      .select('can_schedule, subject_type, subject_id')
      .eq('user_id', uid);
    return (data ?? []).some(
      (g) =>
        g.can_schedule === true &&
        (g.subject_type === 'all' || (g.subject_type === subjectType && g.subject_id === subjectId)),
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Step 1-3: what can I work on at all?
  // ───────────────────────────────────────────────────────────────────────────

  /** The caller's own grants, so the UI can skip steps it cannot offer. */
  router.get('/editor/scope', async (req: Request, res: Response) => {
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
  router.get('/editor/subjects', async (req: Request, res: Response) => {
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

    if (subjectType === 'event') {
      let q = supabase
        .from('events')
        .select('id, event_id, event_title, event_start, event_end')
        .order('event_start', { ascending: false, nullsFirst: false })
        .limit(PAGE);
      if (!unrestricted) q = q.in('id', [...allowed]);
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
      });
    }

    // Podcasts. The table belongs to another module, so a missing table is
    // "no podcasts" rather than an error: `videos` must install on a brand
    // that has no podcasts module at all.
    let q = supabase.from('podcasts').select('id, name, slug').order('name').limit(PAGE);
    if (!unrestricted) q = q.in('id', [...allowed]);
    const { data, error } = await q;
    if (error) {
      logger.warn('podcast list unavailable', { error: error.message });
      return res.json({ subjects: [], unavailable: 'podcasts module not installed' });
    }
    res.json({
      subjects: (data ?? []).map((p) => ({ id: p.id, label: p.name, reference: p.slug })),
    });
  });

  /**
   * Step 6: the units of work within a subject.
   *
   * For an event that is its agenda sessions, because the agenda entry is the
   * sturdier anchor: events_agenda_entries.event_uuid is NOT NULL with a hard
   * FK, while events_talks.event_uuid is nullable under its scope constraint.
   * For a podcast it is the episodes.
   */
  router.get('/editor/subjects/:subjectType/:subjectId/units', async (req: Request, res: Response) => {
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
  router.post('/editor/uploads/mint', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjectType = String(body.subject_type ?? '');
    const subjectId = String(body.subject_id ?? '');
    if (await denyUnlessSubject(req, res, subjectType, subjectId)) return;
    if (!ticketsAvailable()) {
      return res.status(503).json({ error: 'uploads unavailable: SUPABASE_JWT_SECRET is not configured' });
    }

    const unitId = String(body.unit_id ?? '');
    if (!UUID_RE.test(unitId)) return res.status(400).json({ error: 'invalid unit_id' });

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

      const bucket = bucketFor(kind);
      const assetIns = await supabase
        .from('video_assets')
        .insert({
          video_id: videoId,
          kind,
          storage_bucket: bucket,
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

      const signed = await supabase.storage.from(bucket).createSignedUploadUrl(storagePath);
      if (signed.error) {
        await supabase.from('video_assets')
          .update({ state: 'failed', error: `could not sign upload: ${signed.error.message}` })
          .eq('id', assetId);
        out.push({ filename: String(f.filename ?? ''), status: 'failed', reason: signed.error.message });
        continue;
      }

      const sessionIns = await supabase
        .from('video_upload_sessions')
        .insert({
          asset_id: assetId,
          storage_bucket: bucket,
          storage_path: storagePath,
          expected_bytes: Number(f.bytes),
          expected_mime: String(f.mime_type ?? ''),
          created_by: uid,
          expires_at: new Date(Date.now() + TICKET_TTL_SECONDS * 1000).toISOString(),
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
        // The browser PUTs here. Rewritten to the public host because
        // SUPABASE_URL is often an internal name a browser cannot resolve.
        upload_url: externalise(String(signed.data?.signedUrl ?? '')),
        ticket: mintTicket({
          asset_id: assetId,
          session_id: String(sessionIns.data.id),
          storage_bucket: bucket,
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
  router.post('/editor/uploads/complete', async (req: Request, res: Response) => {
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

    const head = await headObject(t.storage_bucket, t.storage_path);
    if (!head.ok) {
      await supabase.from('video_assets')
        .update({ state: 'failed', error: 'stored object not found' })
        .eq('id', t.asset_id);
      return res.status(409).json({ error: 'stored object not found — did the upload finish?' });
    }

    // 10% tolerance mirrors event-media's completion check: storage can
    // report a slightly different length than the client measured.
    if (head.bytes > t.max_bytes * 1.1) {
      await removeObject(t.storage_bucket, t.storage_path);
      await supabase.from('video_assets')
        .update({ state: 'failed', error: 'file too large' })
        .eq('id', t.asset_id);
      return res.status(413).json({ error: 'file_too_large' });
    }

    // The client controls Content-Type on a signed PUT. This is where the
    // mint-time claim is enforced. Fail CLOSED on an empty stored type.
    if (!head.contentType || head.contentType.toLowerCase() !== t.mime_type.toLowerCase()) {
      await removeObject(t.storage_bucket, t.storage_path);
      await supabase.from('video_assets')
        .update({ state: 'failed', error: `mime mismatch: stored ${head.contentType || 'none'}` })
        .eq('id', t.asset_id);
      return res.status(415).json({ error: 'mime_mismatch' });
    }

    // Duration and dimensions are client-reported hints. Nothing in this
    // codebase can extract them server-side (no ffprobe anywhere), so they
    // are stored as given and bounded, and nothing security-relevant depends
    // on them.
    const duration = posInt(body.duration_seconds, 86_400);
    const width = posInt(body.width, 16_384);
    const height = posInt(body.height, 16_384);

    // Supersede a previous ready master so the one-ready-master index holds.
    if (asset.kind === 'master') {
      await supabase
        .from('video_assets')
        .update({ state: 'superseded' })
        .eq('video_id', asset.video_id)
        .eq('kind', 'master')
        .eq('state', 'ready');
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
      .eq('id', t.asset_id);
    if (upd.error) return res.status(500).json({ error: upd.error.message });

    await supabase
      .from('video_upload_sessions')
      .update({ state: 'completed', completed_at: new Date().toISOString() })
      .eq('id', t.session_id);

    logger.info('video asset uploaded', { asset: t.asset_id, kind: asset.kind, bytes: head.bytes });
    res.json({ status: 'complete', asset_id: t.asset_id, video_id: asset.video_id, bytes: head.bytes });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // What is already there, and the generated copy
  // ───────────────────────────────────────────────────────────────────────────

  /** Every video attached to one unit, with its assets and publications. */
  router.get('/editor/subjects/:subjectType/:subjectId/units/:unitId/videos', async (req: Request, res: Response) => {
    const subjectType = String(req.params.subjectType ?? '');
    const subjectId = String(req.params.subjectId ?? '');
    if (await denyUnlessSubject(req, res, subjectType, subjectId)) return;
    const unitId = String(req.params.unitId ?? '');
    if (!UUID_RE.test(unitId)) return res.status(400).json({ error: 'invalid unit id' });

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
  router.get('/editor/videos/:videoId/copy', async (req: Request, res: Response) => {
    if (await denyUnlessAnyGrant(req, res)) return;
    const videoId = String(req.params.videoId ?? '');
    if (!UUID_RE.test(videoId)) return res.status(400).json({ error: 'invalid video id' });

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
  router.post('/editor/videos/:videoId/publications', async (req: Request, res: Response) => {
    if (await denyUnlessAnyGrant(req, res)) return;
    const videoId = String(req.params.videoId ?? '');
    if (!UUID_RE.test(videoId)) return res.status(400).json({ error: 'invalid video id' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjectType = String(body.subject_type ?? '');
    const subjectId = String(body.subject_id ?? '');
    if (await denyUnlessSubject(req, res, subjectType, subjectId)) return;
    if (!(await canSchedule(req, subjectType, subjectId))) {
      return res.status(403).json({ error: 'your access allows uploading but not scheduling' });
    }

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
  router.patch('/editor/publications/:id', async (req: Request, res: Response) => {
    if (await denyUnlessAnyGrant(req, res)) return;
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'invalid publication id' });

    const { data: pub } = await supabase
      .from('video_publications')
      .select('id, state, video_id')
      .eq('id', id)
      .maybeSingle();
    if (!pub) return res.status(404).json({ error: 'publication not found' });

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
  router.get('/editor/assets/:assetId/playback', async (req: Request, res: Response) => {
    if (await denyUnlessAnyGrant(req, res)) return;
    const assetId = String(req.params.assetId ?? '');
    if (!UUID_RE.test(assetId)) return res.status(400).json({ error: 'invalid asset id' });

    const { data: asset } = await supabase
      .from('video_assets')
      .select('storage_bucket, storage_path, state')
      .eq('id', assetId)
      .maybeSingle();
    if (!asset || asset.state !== 'ready') return res.status(404).json({ error: 'no playable asset' });

    const signed = await supabase.storage
      .from(asset.storage_bucket)
      .createSignedUrl(asset.storage_path, 3600);
    if (signed.error) return res.status(500).json({ error: signed.error.message });
    res.json({ url: externalise(String(signed.data?.signedUrl ?? '')), expires_in: 3600 });
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  /** A bounded positive integer from request JSON, or null. */
  function posInt(v: unknown, max: number): number | null {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(Math.round(n), max);
  }

  /**
   * Rewrite an internal Supabase URL to the public one.
   *
   * SUPABASE_URL is often an in-cluster name (http://supabase-kong:8000) that
   * a browser cannot resolve, so a signed URL built from it is useless to the
   * editor. Same split as host-media's buildPublicUrl.
   */
  function externalise(url: string): string {
    const internal = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
    const external = (process.env.SUPABASE_PUBLIC_URL ?? internal).replace(/\/+$/, '');
    if (!internal || internal === external) return url;
    return url.startsWith(internal) ? external + url.slice(internal.length) : url;
  }

  /** The stored object's real size and content type. */
  async function headObject(bucket: string, path: string): Promise<{ ok: boolean; bytes: number; contentType: string }> {
    try {
      const signed = await supabase.storage.from(bucket).createSignedUrl(path, 60);
      if (signed.error || !signed.data?.signedUrl) return { ok: false, bytes: 0, contentType: '' };
      const r = await fetch(signed.data.signedUrl, { method: 'HEAD' });
      if (!r.ok) return { ok: false, bytes: 0, contentType: '' };
      return {
        ok: true,
        bytes: Number(r.headers.get('content-length') ?? 0),
        contentType: String(r.headers.get('content-type') ?? '').split(';')[0].trim(),
      };
    } catch {
      return { ok: false, bytes: 0, contentType: '' };
    }
  }

  async function removeObject(bucket: string, path: string): Promise<void> {
    try {
      await supabase.storage.from(bucket).remove([path]);
    } catch {
      /* best effort: a stray object is better than a wrong row */
    }
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
