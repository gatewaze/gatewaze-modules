// @ts-nocheck — depends on @supabase/supabase-js + express which require
// pnpm install at the modules workspace level (same posture as
// host-media/api/routes.ts).

/**
 * Public guest-upload routes — token-gated, no login.
 *
 *   GET  /public/event-media/links/:code                   resolve link
 *   GET  /public/event-media/links/:code/media             approved media feed
 *   POST /public/event-media/links/:code/uploads           mint signed PUTs + tickets
 *   POST /public/event-media/links/:code/uploads/complete  verify tickets, create rows
 *
 * Mounted by register-routes.ts at app.use('/api', publicRouter) so the
 * URLs sit OUTSIDE /api/modules (which is JWT + super-admin gated
 * upstream). The short code is the authorization (invites precedent),
 * hardened per spec-event-media-guest-uploads §9: every route is
 * rate-limited per IP BEFORE the code is resolved, codes are 10
 * crypto-random base36 chars, and unknown/inactive/expired codes all
 * return the same 404.
 */

import type { Request, Response, Router } from 'express';
import {
  GUEST_RATE_LIMITS,
  MAX_FILES_PER_MINT,
  buildGuestStoragePath,
  cleanGuestName,
  guestRateKey,
  newMediaId,
  paramAsShortCode,
  sanitiseGuestFilename,
  validateMintFile,
} from '../lib/guest-limits.js';
import { READY_PROMPTS, readyPrompt, readyWindow } from '../lib/ready-prompts.js';
import { plateHasPeople, runCardCopy, runCutout, runDepth, runPlate } from '../lib/booth-provider.js';
import { bounded } from '../lib/bounded.js';
import { browserObjectUrl, browserSizedUrl, type CdnConfig } from '../lib/cdn.js';
import { albumForUpload, isView, resolveViews, tagView, type View } from '../lib/view-albums.js';
import eventMediaModule from '../index.js';
import { displayName, matchGuests, type GuestEntry } from '../lib/guest-identity.js';
import {
  TICKET_TTL_SECONDS,
  mintTicket,
  verifyTicket,
  type UploadTicketPayload,
} from '../lib/upload-tickets.js';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface GuestRoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  storageBucket: string;
  /** External Supabase hostname for URLs handed to browsers. */
  publicSupabaseUrl: string;
  /** Internal Supabase hostname (what the server-side client uses). */
  internalSupabaseUrl: string;
  rateLimit: (key: string, max: number, windowMs: number) => Promise<{ allowed: boolean; resetAt: number }>;
  logger: PlatformLogger;
  /** Resolved ONCE at mount (register-routes) — never per-request, so a
   *  missing SUPABASE_JWT_SECRET can't throw inside an unauthenticated
   *  handler (Express 4 turns that into an unhandledRejection →
   *  process.exit via the Sentry hook; evidence review 2026-09-19, F3).
   *  null → mint/complete answer 503 not_configured. */
  ticketSecret: string | null;
  /**
   * Browser-facing image host. Resolved once at mount; absent or off
   * means browsers fetch straight from Supabase, exactly as before.
   */
  cdn?: CdnConfig;
}

interface UploadLinkRow {
  id: string;
  event_id: string;
  short_code: string;
  label: string;
  is_active: boolean;
  expires_at: string | null;
  require_name: boolean;
  allow_video: boolean;
  auto_approve: boolean;
  show_gallery: boolean;
  max_photo_bytes: number;
  max_video_bytes: number;
  logo_url: string | null;
  allow_face_filter: boolean;
}

interface EventRow {
  id: string;
  event_id: string | null;
  event_slug: string | null;
  event_title: string | null;
  /** When the event starts; uploads before it are Getting ready. */
  event_start?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Strict ISO-8601 (what PostgREST emits for timestamptz). Validated
// before any interpolation into a PostgREST filter string.
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
// The shape of a registered album slug (migration 026's CHECK). Slugs
// come from the database, not the request, but they are matched against
// request input and echoed back as paths, so only this shape is served.
const ALBUM_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

function sendError(res: Response, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  const body: Record<string, unknown> = { error: code, message };
  if (details) body.details = details;
  res.status(status).json(body);
}

function clientIp(req: Request): string {
  return (req.ip ?? 'unknown').toString();
}

export function createGuestRoutes(deps: GuestRoutesDeps) {
  const { supabase, storageBucket, publicSupabaseUrl, internalSupabaseUrl, rateLimit, logger } = deps;
  const cdn: CdnConfig = deps.cdn ?? { zone: null };

  function toPublicUrl(storagePath: string): string {
    return `${publicSupabaseUrl}/storage/v1/object/public/${storageBucket}/${storagePath}`;
  }

  /** Signed URLs come back on the server-side (often in-cluster) host;
   *  browsers need the external one. */
  function externaliseUrl(url: string): string {
    if (internalSupabaseUrl && url.startsWith(internalSupabaseUrl)) {
      return `${publicSupabaseUrl}${url.slice(internalSupabaseUrl.length)}`;
    }
    return url;
  }

  async function checkRate(res: Response, key: string, limit: { max: number; windowMs: number }): Promise<boolean> {
    const rl = await rateLimit(key, limit.max, limit.windowMs);
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000)).toString());
      sendError(res, 429, 'rate_limited', 'too many requests');
      return false;
    }
    return true;
  }

  /** Shared resolution: rate limit → code shape → link row → liveness →
   *  parent event. All failure shapes are the same 404 (no enumeration
   *  oracle). Returns null after responding.
   *
   *  `op` keeps each endpoint in its OWN per-IP bucket — a wedding venue
   *  is one NAT IP, and a shared bucket would let gallery polling starve
   *  uploads (evidence review 2026-09-19, F2). */
  async function resolveLink(
    req: Request,
    res: Response,
    op: string,
    ipLimit: { max: number; windowMs: number },
  ): Promise<{ link: UploadLinkRow; event: EventRow } | null> {
    if (!(await checkRate(res, guestRateKey(`${op}:ip`, clientIp(req)), ipLimit))) return null;

    const code = paramAsShortCode(req.params['code']);
    if (!code) {
      sendError(res, 404, 'link_not_found', 'unknown upload link');
      return null;
    }

    const { data: link, error } = await supabase
      .from('events_media_upload_links')
      .select('id, event_id, short_code, label, is_active, expires_at, require_name, allow_video, auto_approve, show_gallery, max_photo_bytes, max_video_bytes, logo_url, allow_face_filter, role, credit_name, credit_member_id')
      .eq('short_code', code)
      .maybeSingle();
    if (error) {
      logger.error('guest link lookup failed', { error: error.message });
      sendError(res, 500, 'lookup_failed', 'could not resolve link');
      return null;
    }
    const active = link
      && link.is_active
      && (!link.expires_at || new Date(link.expires_at).getTime() > Date.now());
    if (!active) {
      sendError(res, 404, 'link_not_found', 'unknown upload link');
      return null;
    }

    const { data: event, error: evErr } = await supabase
      .from('events')
      .select('id, event_id, event_slug, event_title, event_start')
      .eq('id', link.event_id)
      .maybeSingle();
    if (evErr || !event) {
      sendError(res, 404, 'link_not_found', 'unknown upload link');
      return null;
    }

    res.setHeader('Cache-Control', 'no-store');
    return { link: link as UploadLinkRow, event: event as EventRow };
  }

  // ── Guest identity (lib/guest-identity.ts) ──────────────────────────
  // The accepted invitation list, and the organiser's block list, per
  // event. Cached briefly: the list changes rarely, and a block should
  // bite within seconds, not minutes.
  const GUEST_LIST_TTL_MS = 60_000;
  const BLOCKS_TTL_MS = 10_000;
  const guestListCache = new Map<string, { at: number; list: GuestEntry[] | null }>();
  const blocksCache = new Map<string, { at: number; ids: Set<string> }>();

  /** null: the event has no invitation list, so names are typed freely. */
  async function guestListFor(eventId: string): Promise<GuestEntry[] | null> {
    const hit = guestListCache.get(eventId);
    if (hit && Date.now() - hit.at < GUEST_LIST_TTL_MS) return hit.list;
    let list: GuestEntry[] | null = null;
    try {
      const { data, error } = await supabase
        .from('invite_party_member_events')
        .select('invite_party_members(id, first_name, last_name)')
        .eq('event_id', eventId)
        .eq('rsvp_status', 'accepted')
        .limit(5000);
      // An error usually means the invitations module is not installed
      // here, which is simply "no guest list".
      if (!error) {
        const out: GuestEntry[] = [];
        for (const r of (data ?? []) as Array<{ invite_party_members: { id: string; first_name: unknown; last_name: unknown } | null }>) {
          const m = r.invite_party_members;
          const name = m ? displayName(m.first_name, m.last_name) : null;
          if (m && name && UUID_RE.test(m.id)) out.push({ id: m.id, name });
        }
        list = out.length > 0 ? out : null;
      }
    } catch {
      list = null;
    }
    guestListCache.set(eventId, { at: Date.now(), list });
    return list;
  }

  async function blockedFor(eventId: string): Promise<Set<string>> {
    const hit = blocksCache.get(eventId);
    if (hit && Date.now() - hit.at < BLOCKS_TTL_MS) return hit.ids;
    const ids = new Set<string>();
    const { data, error } = await supabase
      .from('events_media_guest_blocks')
      .select('member_id')
      .eq('event_id', eventId);
    if (!error) for (const r of (data ?? []) as Array<{ member_id: string }>) if (UUID_RE.test(r.member_id)) ids.add(r.member_id);
    blocksCache.set(eventId, { at: Date.now(), ids });
    return ids;
  }

  /**
   * Who is uploading. With a guest list, the member id must name someone
   * on it who has not been blocked; without one, any typed name will do
   * (guest: null) and the caller falls back to that.
   */
  // ── Name claims (migration 011) ─────────────────────────────────
  // One phone per name. Read fresh every time: a claim must bite at once.
  async function claimsFor(eventId: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const { data, error } = await supabase
      .from('events_media_guest_claims')
      .select('member_id, client_id')
      .eq('event_id', eventId)
      .limit(5000);
    if (!error) for (const r of (data ?? []) as Array<{ member_id: string; client_id: string }>) out.set(r.member_id, r.client_id);
    return out;
  }

  /** Take a name for this phone: 'ok' if it now holds it, 'taken' if another does. */
  async function claim(eventId: string, guest: GuestEntry, clientId: string): Promise<'ok' | 'taken' | 'error'> {
    const { error } = await supabase
      .from('events_media_guest_claims')
      .upsert(
        { event_id: eventId, member_id: guest.id, client_id: clientId, guest_name: guest.name },
        { onConflict: 'event_id,member_id', ignoreDuplicates: true },
      );
    if (error) return 'error';
    const { data } = await supabase
      .from('events_media_guest_claims')
      .select('client_id')
      .eq('event_id', eventId)
      .eq('member_id', guest.id)
      .maybeSingle();
    return data?.client_id === clientId ? 'ok' : 'taken';
  }

  /**
   * Who is uploading. With a guest list, the member id must name someone
   * on it, not blocked, and held by this phone (claimed now if nobody holds
   * it yet); without one, any typed name will do (guest: null) and the
   * caller falls back to that.
   */
  async function identify(eventId: string, raw: unknown, clientId: string | null): Promise<
    | { ok: true; guest: GuestEntry | null }
    | { ok: false; status: number; code: string; message: string }
  > {
    const list = await guestListFor(eventId);
    if (!list) return { ok: true, guest: null };
    const id = typeof raw === 'string' && UUID_RE.test(raw) ? raw : null;
    const guest = id ? list.find((g) => g.id === id) ?? null : null;
    if (!guest || !clientId) return { ok: false, status: 400, code: 'guest_required', message: 'please choose your name from the guest list' };
    if ((await blockedFor(eventId)).has(guest.id)) {
      return { ok: false, status: 403, code: 'guest_blocked', message: 'uploads are paused for this guest' };
    }
    const held = await claim(eventId, guest, clientId);
    if (held === 'taken') {
      return { ok: false, status: 409, code: 'name_taken', message: 'that name has been chosen on another phone' };
    }
    if (held === 'error') return { ok: false, status: 500, code: 'claim_failed', message: 'could not check your name' };
    return { ok: true, guest };
  }

  /**
   * May this phone manage this photo? Its own uploads, or -- on an event
   * with a guest list -- any photo of the guest whose name it holds.
   */
  async function mayManage(eventId: string, meta: Record<string, unknown>, clientId: string): Promise<boolean> {
    if (meta['client_id'] === clientId) return true;
    const member = typeof meta['member_id'] === 'string' ? meta['member_id'] : null;
    if (!member) return false;
    return (await claimsFor(eventId)).get(member) === clientId;
  }

  const clientIdOf = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null);

  // POST /public/event-media/links/:code/guests/claim   { client_id, member_id }
  async function claimGuest(req: Request, res: Response): Promise<void> {
    const ctx = await resolveLink(req, res, 'guests', GUEST_RATE_LIMITS.guestSearchPerIp);
    if (!ctx) return;
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const clientId = clientIdOf(body['client_id']);
    if (!clientId) { sendError(res, 400, 'invalid_request', 'client_id must be a UUID'); return; }
    const who = await identify(ctx.link.event_id, body['member_id'], clientId);
    if (!who.ok) { sendError(res, who.status, who.code, who.message); return; }
    res.status(200).json({ guest: who.guest });
  }

  // POST /public/event-media/links/:code/guests/release   { client_id, member_id }
  async function releaseGuest(req: Request, res: Response): Promise<void> {
    const ctx = await resolveLink(req, res, 'guests', GUEST_RATE_LIMITS.guestSearchPerIp);
    if (!ctx) return;
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const clientId = clientIdOf(body['client_id']);
    const memberId = clientIdOf(body['member_id']);
    if (!clientId || !memberId) { sendError(res, 400, 'invalid_request', 'client_id and member_id must be UUIDs'); return; }
    // Only the phone holding the name can let it go.
    await supabase
      .from('events_media_guest_claims')
      .delete()
      .eq('event_id', ctx.link.event_id)
      .eq('member_id', memberId)
      .eq('client_id', clientId);
    res.status(200).json({ released: memberId });
  }

  // ────────────────────────────────────────────────────────────────────
  // GET /public/event-media/links/:code/guests?q=da
  // A few names from the accepted invitation list, for the name picker.
  // At least two letters, at most eight matches: never the whole list.
  // ────────────────────────────────────────────────────────────────────
  async function searchGuests(req: Request, res: Response): Promise<void> {
    const ctx = await resolveLink(req, res, 'guests', GUEST_RATE_LIMITS.guestSearchPerIp);
    if (!ctx) return;
    const list = await guestListFor(ctx.link.event_id);
    if (!list) {
      sendError(res, 404, 'no_guest_list', 'this event has no guest list');
      return;
    }
    // Names another phone holds are not offered.
    const me = clientIdOf(req.query['client_id']);
    const held = await claimsFor(ctx.link.event_id);
    const free = list.filter((g) => { const by = held.get(g.id); return !by || by === me; });
    res.status(200).json({ guests: matchGuests(free, req.query['q']) });
  }

  // ────────────────────────────────────────────────────────────────────
  // GET /public/event-media/links/:code
  // ────────────────────────────────────────────────────────────────────
  async function getLink(req: Request, res: Response): Promise<void> {
    const ctx = await resolveLink(req, res, 'resolve', GUEST_RATE_LIMITS.resolvePerIp);
    if (!ctx) return;
    const { link, event } = ctx;

    res.status(200).json({
      // The projector reloads itself when this changes, so a screen left
      // open all day picks up fixes without anyone touching it.
      version: eventMediaModule.version,
      event: {
        // uuid included for the display page's realtime INSERT filter
        // (host_id=eq.<uuid>); not privileged — RLS gates the reads.
        id: event.id,
        identifier: event.event_slug || event.event_id,
        slug: event.event_slug,
        // Text event_id included separately: the portal event page
        // resolves BOTH slug and event_id URLs, and the client's
        // cross-event guard must accept either spelling.
        event_id: event.event_id,
        name: event.event_title,
        starts_at: event.event_start ?? null,
      },
      // The morning before: from a day and a half out until the event
      // starts, the app leads with things to photograph while everyone
      // is getting ready (lib/ready-prompts.ts).
      ready: await (async () => {
        const { data: ms } = await supabase
          .from('events_media_booth_settings')
          .select('ready_hours')
          .eq('event_id', link.event_id)
          .maybeSingle();
        const w = readyWindow(event.event_start, Date.now(), ms?.ready_hours ?? null);
        return {
          active: w.active,
          starts_at: w.starts_at,
          prompts: w.active
            ? READY_PROMPTS.map((p) => ({ id: p.id, label: p.label, blurb: p.blurb, camera: p.camera }))
            : [],
        };
      })(),
      settings: {
        require_name: link.require_name,
        allow_video: link.allow_video,
        show_gallery: link.show_gallery,
        max_photo_bytes: link.max_photo_bytes,
        max_video_bytes: link.max_video_bytes,
        // Guests pick their name from the invitation list rather than
        // typing one.
        guest_list: Boolean(await guestListFor(link.event_id)),
        // A photographer's link opens a different page: a delivery, not
        // a party. The credit is the organiser's, so the page shows who
        // it will say rather than asking for a name.
        role: link.role === 'photographer' ? 'photographer' : 'guest',
        credit: link.role === 'photographer' ? (link.credit_name ?? null) : null,
      },
      logo_url: link.logo_url && /^https?:\/\//.test(link.logo_url)
        ? link.logo_url
        : link.logo_url
          ? toPublicUrl(link.logo_url.replace(/^\/+/, ''))
          : null,
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // GET /public/event-media/links/:code/media
  // ────────────────────────────────────────────────────────────────────
  interface FeedRow {
    id: string;
    storage_path: string;
    mime_type: string;
    bytes: number;
    width: number | null;
    height: number | null;
    variants: Record<string, string> | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }

  /** Write one generated asset next to the photo and record the path. */
  async function storeVariant(
    mediaId: string,
    storagePath: string,
    name: string,
    bytes: Uint8Array,
    contentType: string,
    ext: string,
  ): Promise<boolean> {
    const dir = storagePath.slice(0, storagePath.lastIndexOf('/'));
    if (!dir) return false;
    const path = `${dir}/variants/${name}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(storageBucket)
      .upload(path, bytes, { contentType, upsert: true });
    if (upErr) {
      logger.warn('layer upload failed', { mediaId, name, error: upErr.message });
      return false;
    }
    // Merge rather than replace: the image-variant edge function writes
    // thumb/medium into the same column and may land either side of this.
    const { data: row } = await supabase
      .from('host_media')
      .select('variants')
      .eq('id', mediaId)
      .maybeSingle();
    const variants = { ...((row?.variants ?? {}) as Record<string, unknown>), [name]: path };
    await supabase.from('host_media').update({ variants }).eq('id', mediaId);
    return true;
  }

  /**
   * Build the projector's 3D layers for one photo.
   *
   * Three assets, each generated once and cached, because they are
   * properties of the PHOTO rather than of whoever is viewing it:
   *
   *   cutout  the people, soft alpha        — the near layer
   *   plate   the scene with nobody in it   — the far layer
   *   depth   monocular depth map           — relief within a layer
   *
   * Moving two complete layers is what makes the parallax honest. The
   * previous approach displaced one flat image by its depth map, which
   * smears at every edge because there is nothing behind the subject to
   * reveal — the torn cutouts the effect was rightly criticised for.
   *
   * Fire-and-forget and defensively total: this runs detached from the
   * request, so anything thrown here would surface as an
   * unhandledRejection and take the API process down.
   */
  /** Point a variant at an existing object, merging like storeVariant. */
  async function setVariantPath(mediaId: string, name: string, path: string): Promise<void> {
    const { data: row } = await supabase.from('host_media').select('variants').eq('id', mediaId).maybeSingle();
    const variants = { ...((row?.variants ?? {}) as Record<string, unknown>), [name]: path };
    await supabase.from('host_media').update({ variants }).eq('id', mediaId);
  }

  /**
   * The background plate, checked before it is kept. The image model
   * sometimes redraws the scene with the person still in it; the
   * projector then draws them twice. So a vision model looks at every
   * plate: a plate with a person in it is retried once with a firmer
   * prompt, and if that fails too the plate is pointed at the photo
   * itself -- which the display reads as "no usable plate" and shows the
   * photo flat, straight away, rather than doubled or four minutes late.
   * When the check itself cannot run, the plate is kept (the display's
   * own pixel check still applies).
   */
  async function checkedPlate(mediaId: string, storagePath: string, src: string): Promise<void> {
    const dir = storagePath.slice(0, storagePath.lastIndexOf('/'));
    for (const strict of [false, true]) {
      const r = await runPlate(src, strict);
      if (!r.ok) {
        logger.warn('layer generation failed', { mediaId, name: 'plate', error: r.error, detail: r.detail });
        continue;
      }
      const candidate = `${dir}/variants/plate-check-${strict ? 2 : 1}.jpg`;
      const { error: upErr } = await supabase.storage
        .from(storageBucket)
        .upload(candidate, r.image, { contentType: 'image/jpeg', upsert: true });
      const people = upErr ? null : await plateHasPeople(toPublicUrl(candidate));
      await removeObject(candidate);
      if (people !== true) {
        await storeVariant(mediaId, storagePath, 'plate', r.image, 'image/jpeg', 'jpg');
        return;
      }
      logger.warn('plate still shows a person', { mediaId, attempt: strict ? 2 : 1 });
    }
    await setVariantPath(mediaId, 'plate', storagePath);
  }

  /**
   * How many photographs may be having their layers generated at once.
   *
   * Two, because each one holds a depth map, a cutout and up to two
   * candidate plates in a pod that has 512MB in total. Before this bound
   * existed every upload started its own, and a batch of eighty was
   * enough to be OOMKilled twice over (2026-10-17). Layers are detached
   * work that nothing is waiting on, so queueing them costs only time.
   */
  const layerQueue = bounded(2, (err) => {
    logger.warn('layer job crashed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  async function generateLayers(mediaId: string, storagePath: string): Promise<void> {
    try {
      const src = toPublicUrl(storagePath);

      // Browse-card copy lives in metadata rather than storage — it is a
      // few short strings, not a file. Started BEFORE the layers and
      // never awaited alongside them: it is the only one of these the
      // guest actually reads, and it used to be skipped entirely
      // whenever a layer threw.
      // Not put through the layer queue: that bound is there to keep
      // decoded images out of the pod's memory, and this holds none --
      // the model is handed a URL and answers with a few short strings.
      // It is caught, though. Nothing awaits this, so a throw from the
      // model or either query would surface as an unhandledRejection and
      // take the process down.
      void (async () => {
        try {
          const copy = await runCardCopy(src);
          if (!copy.ok) {
            logger.warn('card copy failed', { mediaId, error: copy.error });
            return;
          }
          const { data: row } = await supabase
            .from('host_media')
            .select('metadata')
            .eq('id', mediaId)
            .maybeSingle();
          const metadata = { ...((row?.metadata ?? {}) as Record<string, unknown>), card: copy.copy };
          await supabase.from('host_media').update({ metadata }).eq('id', mediaId);
        } catch (err) {
          logger.warn('card copy crashed', {
            mediaId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();

      const [depth, cutout] = await Promise.all([
        runDepth(src),
        runCutout(src),
        checkedPlate(mediaId, storagePath, src),
      ]);

      if (depth.ok) await storeVariant(mediaId, storagePath, 'depth', depth.image, 'image/png', 'png');
      if (cutout.ok) await storeVariant(mediaId, storagePath, 'cutout', cutout.image, 'image/png', 'png');
      for (const [name, r] of [['depth', depth], ['cutout', cutout]] as const) {
        if (!r.ok) logger.warn('layer generation failed', { mediaId, name, error: r.error, detail: r.detail });
      }
    } catch (err) {
      logger.warn('layer generation crashed', {
        mediaId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * What every photo bound for the projector gets once it exists: its 3D
   * layers. Fire-and-forget.
   *
   * No thumbnails are made. Sizes come off the CDN on the fly instead
   * (asked 2026-09-27): the same original, asked for at the width the
   * page wants, cached at the edge by that width. Stored copies cost
   * storage and an edge function that could not decode a multi-megapixel
   * photograph anyway -- and they went stale the moment a photograph was
   * rotated, since each one had to be turned alongside it.
   */
  function processNewImage(mediaId: string, storagePath: string): void {
    layerQueue(() => generateLayers(mediaId, storagePath));
  }

  /**
   * A resized copy for a browser. Through Bunny when configured, so
   * Supabase's per-transformation render endpoint is never hit; otherwise
   * the render endpoint, as before.
   */
  function toRenderUrl(storagePath: string, width: number): string {
    return browserSizedUrl(cdn, publicSupabaseUrl, storageBucket, storagePath, width);
  }

  /**
   * An original for a browser. Deliberately separate from toPublicUrl,
   * which also builds the source URLs handed to the image models —
   * including short-lived scratch files there is no point caching.
   */
  function toBrowserUrl(storagePath: string): string {
    return browserObjectUrl(cdn, publicSupabaseUrl, storageBucket, storagePath);
  }

  /**
   * The projector view of each photo on a page, from its view-album
   * membership (lib/view-albums.ts). Never fails the feed: on any error
   * the photos fall back to their tags, which is where they were shown
   * before the albums existed.
   */
  async function viewsFor(eventId: string, rows: FeedRow[]): Promise<Map<string, View>> {
    const tags = new Map(rows.map((r) => [r.id, tagView(r.metadata)] as [string, View]));
    if (rows.length === 0) return tags;
    try {
      const { data: albums, error: aErr } = await supabase
        .from('event_media_view_albums')
        .select('album_id, view')
        .eq('event_id', eventId);
      if (aErr) throw new Error(aErr.message);
      if (!albums || albums.length === 0) return tags;
      // Ids come from the rows just read, never from the request.
      const { data: items, error: iErr } = await supabase
        .from('host_media_album_items')
        .select('album_id, media_id')
        .in('album_id', albums.map((a: { album_id: string }) => a.album_id))
        .in('media_id', rows.map((r) => r.id));
      if (iErr) throw new Error(iErr.message);
      return resolveViews(albums, items ?? [], tags);
    } catch (err) {
      logger.warn('view albums unavailable; using tags', {
        eventId, error: err instanceof Error ? err.message : String(err),
      });
      return tags;
    }
  }

  /**
   * The event's registered gallery albums (migration 006, opened up by
   * migration 026): every event_media_view_albums row, with the album's
   * own name and sort order. The eight projector views are the slugs the
   * weddings used; anything else is an album registered by an ingest
   * (conference photos from Drive, the retired events_media copies).
   *
   * Never allowed to fail the page: with nothing registered the gallery
   * offers the standing views under their fallback names, which is where
   * this started.
   */
  async function registeredAlbums(eventId: string): Promise<Array<{
    slug: string; albumId: string; name: string | null; sortOrder: number;
  }>> {
    try {
      const { data, error } = await supabase
        .from('event_media_view_albums')
        .select('view, album_id, host_media_albums(name, sort_order)')
        .eq('event_id', eventId);
      if (error) throw new Error(error.message);
      return ((data ?? []) as Array<{
        view: string; album_id: string;
        host_media_albums: { name?: string | null; sort_order?: number | null } | null;
      }>)
        // The slug is interpolated nowhere, but it is matched against
        // request input and echoed back as a path, so only the shape the
        // CHECK constraint allows is served.
        .filter((a) => typeof a.view === 'string' && ALBUM_SLUG_RE.test(a.view))
        .map((a) => ({
          slug: a.view,
          albumId: a.album_id,
          name: a.host_media_albums?.name ?? null,
          sortOrder: Number.isFinite(a.host_media_albums?.sort_order)
            ? (a.host_media_albums!.sort_order as number)
            : 0,
        }));
    } catch (err) {
      logger.warn('view albums unavailable; offering the standing views', {
        eventId, error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * The albums an organiser has taken off the portal (migration 016),
   * and the ones showing improved copies. Keyed by the album's gallery
   * slug -- a projector view or a registered album's own slug -- so the
   * settings apply to an ingested album exactly as they did to the
   * wedding's.
   *
   * Never allowed to fail the page: a settings table that cannot be read
   * shows every album, which is where this started.
   */
  async function albumSettings(eventId: string, slugOf: ReadonlyMap<string, string>): Promise<{
    hidden: Set<string>; enhanced: Set<string>; xray: Set<string>; relit: Set<string>;
    /** Albums that read forwards by default (migration 029). */
    oldestFirst: Set<string>;
  }> {
    const hidden = new Set<string>();
    const enhanced = new Set<string>();
    const xray = new Set<string>();
    // Albums asking for the model's copy rather than the arithmetic one.
    const relit = new Set<string>();
    const oldestFirst = new Set<string>();
    try {
      const { data: rows, error } = await supabase
        .from('event_media_album_settings')
        .select('album_id, show_on_portal, enhance, xray, enhance_source, sort')
        .eq('event_id', eventId);
      if (error) throw new Error(error.message);
      if (!rows || rows.length === 0) return { hidden, enhanced, xray, relit, oldestFirst };
      for (const r of rows as Array<{
        album_id: string; show_on_portal: boolean; enhance?: boolean; xray?: boolean;
        enhance_source?: string | null; sort?: string | null;
      }>) {
        const slug = slugOf.get(r.album_id);
        if (!slug) continue;
        if (r.show_on_portal === false) hidden.add(slug);
        if (r.enhance === true) enhanced.add(slug);
        if (r.xray === true) xray.add(slug);
        if (r.enhance_source === 'ai') relit.add(slug);
        if (r.sort === 'oldest') oldestFirst.add(slug);
      }
    } catch (err) {
      logger.warn('album settings unavailable; showing every album as it is', {
        eventId, error: err instanceof Error ? err.message : String(err),
      });
    }
    return { hidden, enhanced, xray, relit, oldestFirst };
  }

  /**
   * When this event's evening reception starts, in minutes past
   * midnight, or null for the usual half past six (migration 022).
   */
  async function eveningFromFor(eventId: string): Promise<number | null> {
    try {
      const { data } = await supabase
        .from('events_media_booth_settings')
        .select('evening_from_minutes')
        .eq('event_id', eventId)
        .maybeSingle();
      const v = Number(data?.evening_from_minutes);
      return Number.isFinite(v) && v >= 0 && v < 1440 ? Math.floor(v) : null;
    } catch {
      return null;
    }
  }

  function mapFeedItem(r: FeedRow, view?: View) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const variants: Record<string, string> = {};
    if (r.variants && typeof r.variants === 'object') {
      for (const [k, v] of Object.entries(r.variants)) {
        // No enhanced copy is handed out here, of the photograph or of
        // the selfie behind it. They are shown only where an organiser
        // has turned enhancement on for the album, and that is decided
        // by the gallery, which puts them in itself -- otherwise turning
        // the album back off would leave a working URL to them sitting
        // in the payload.
        // A draft is a working file the browser has not corrected yet;
        // it never leaves here at all.
        if (k === 'enhanced' || k === 'enhanced_selfie'
          || k === 'enhanced_ai' || k === 'enhanced_ai_selfie') continue;
        if (typeof v === 'string' && v) variants[k] = toBrowserUrl(v);
      }
    }
    // Sizes are always made on the fly from the original, never read
    // from the row: one file per photograph, resized at the edge and
    // cached there by width. A thumb or medium a row still carries from
    // when they were stored is ignored -- it is the wrong way up for a
    // photograph that has since been turned.
    if (r.mime_type.startsWith('image/')) {
      variants['thumb'] = toRenderUrl(r.storage_path, 350);
      variants['medium'] = toRenderUrl(r.storage_path, 800);
    }
    return {
      id: r.id,
      kind: r.mime_type.startsWith('video/') ? 'video' : 'photo',
      url: toBrowserUrl(r.storage_path),
      mime_type: r.mime_type,
      width: r.width,
      height: r.height,
      variants,
      guest_name: meta['source'] === 'guest' && typeof meta['guest_name'] === 'string' ? meta['guest_name'] : null,
      card: meta['card'] && typeof meta['card'] === 'object' ? meta['card'] : null,
      // The photograph the guest actually took, where the booth kept one
      // -- the projector has a view of its own for these.
      selfie: typeof meta['selfie'] === 'string' && meta['selfie'] ? toBrowserUrl(meta['selfie']) : null,
      // 'booth' | 'day' | 'seed': the view album it is in, else its tag.
      // Older rows predate the tag and read as 'seed', which they are.
      album: view ?? tagView(meta),
      created_at: r.created_at,
    };
  }

  function decodeCursor(raw: unknown): { t: string; i: string } | null {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return null;
    try {
      const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { t?: unknown; i?: unknown };
      if (typeof parsed.t !== 'string' || !ISO_TS_RE.test(parsed.t)) return null;
      if (typeof parsed.i !== 'string' || !UUID_RE.test(parsed.i)) return null;
      return { t: parsed.t, i: parsed.i };
    } catch {
      return null;
    }
  }

  function encodeCursor(t: string, i: string): string {
    return Buffer.from(JSON.stringify({ t, i }), 'utf8').toString('base64url');
  }

  async function listMedia(req: Request, res: Response): Promise<void> {
    const ctx = await resolveLink(req, res, 'list', GUEST_RATE_LIMITS.mediaListPerIp);
    if (!ctx) return;
    const { link } = ctx;

    if (!link.show_gallery) {
      sendError(res, 404, 'link_not_found', 'unknown upload link');
      return;
    }

    const filter = typeof req.query['filter'] === 'string' ? req.query['filter'] : 'all';
    const limit = Math.max(1, Math.min(Number(req.query['limit'] ?? 50) || 50, 200));
    const after = typeof req.query['after'] === 'string' && ISO_TS_RE.test(req.query['after'])
      ? req.query['after']
      : null;
    const cursor = decodeCursor(req.query['cursor']);

    let query = supabase
      .from('host_media')
      .select('id, storage_path, mime_type, bytes, width, height, variants, metadata, created_at')
      .eq('host_kind', 'event')
      .eq('host_id', link.event_id)
      .eq('access_level', 'public')
      .eq('is_approved', true)
      // Booth pictures are kept whether or not the guest posts them, and
      // only posted ones are anyone else's to see. A constant filter: no
      // request input reaches it.
      .or('metadata->>posted.is.null,metadata->>posted.neq.false')
      // ARRIVAL ORDER, DELIBERATELY -- unlike the gallery, which sorts by
      // when a photograph was taken (migration 028). This is the
      // projector's feed: it shows what has just come in, so a picture is
      // dated when it arrives, and the cursor below pages on exactly
      // these two columns. Sorting it by capture time would both bury a
      // photograph somebody has this second uploaded and break the
      // cursor, which is a created_at/id pair.
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      // Over-fetch: hidden rows are filtered below and would otherwise
      // eat into the page size.
      .limit(limit * 2 + 1);

    // A blocked guest's photos leave the projector and the gallery. The
    // ids are the event's own block rows, UUID-checked; no request input
    // reaches this filter. Null-safe, so photos with no guest stay.
    const blocked = [...(await blockedFor(link.event_id))];
    if (blocked.length > 0) {
      query = query.or(`metadata->>member_id.is.null,metadata->>member_id.not.in.(${blocked.join(',')})`);
    }

    if (filter === 'photo') query = query.like('mime_type', 'image/%');
    else if (filter === 'video') query = query.like('mime_type', 'video/%');

    if (after) {
      // Incremental poll (display page): everything at-or-newer than the
      // newest item the client has, same DESC ordering. gte (not gt) so a
      // row committing later with an EQUAL timestamp is never permanently
      // missed — clients dedup by id, so re-delivering ties is free.
      query = query.gte('created_at', after);
    } else if (cursor) {
      // Keyset page: (created_at, id) < (t, i). Both values validated
      // (ISO / UUID) before interpolation — no user-shaped bytes reach
      // the filter string.
      query = query.or(`created_at.lt.${cursor.t},and(created_at.eq.${cursor.t},id.lt.${cursor.i})`);
    }

    const { data, error } = await query;
    if (error) {
      logger.error('guest media list failed', { error: error.message });
      sendError(res, 500, 'list_failed', 'could not list media');
      return;
    }

    // Photos an operator has hidden — too soft or too dark to put on a
    // projector — stay out of the feed. Hiding rather than deleting, so
    // a judgement call about quality is always reversible.
    const rows = ((data ?? []) as FeedRow[]).filter(
      (r) => ((r.metadata ?? {}) as Record<string, unknown>)['hidden'] !== true,
    );
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit && !after;
    const last = page[page.length - 1];
    const views = await viewsFor(link.event_id, page);
    res.status(200).json({
      items: page.map((r) => mapFeedItem(r, views.get(r.id))),
      next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // GET /public/event-media/events/:identifier/gallery
  // ────────────────────────────────────────────────────────────────────
  /**
   * The event's photographs as an album, for anyone who opens the page.
   *
   * The guest app is reached with an upload code on the URL; somebody who
   * just opens /photos has none, and used to be asked who they were and
   * shown nothing (reported 2026-09-27). They get the gallery instead,
   * with the albums to move between -- the shape the old portal had.
   *
   * Keyed by the event, not by a link: handing a link code to a page that
   * needs no code would hand out the right to upload with it. The
   * organiser's own switch still decides whether there is a gallery at
   * all -- at least one active link must have show_gallery, or the event
   * must have a portal-visible ingested album with an approved public
   * photograph in it (a conference whose photos arrived from Drive has no
   * upload link to switch) -- so an event that never showed guests a
   * gallery does not start now.
   *
   * One query for the event's photographs rather than a page at a time,
   * because the album counts have to be true and the albums are resolved
   * in this process; a wedding's few hundred are nothing, and GALLERY_MAX
   * is the ceiling.
   */
  async function eventGallery(req: Request, res: Response): Promise<void> {
    if (!(await checkRate(res, guestRateKey('gallery:ip', clientIp(req)), GUEST_RATE_LIMITS.mediaListPerIp))) return;

    const raw = req.params['identifier'];
    // Slug or short code, and nothing else: no comma, dot or bracket can
    // reach a PostgREST filter from here.
    const ident = typeof raw === 'string' && /^[a-z0-9][a-z0-9-]{0,80}$/i.test(raw) ? raw : null;
    if (!ident) { sendError(res, 404, 'event_not_found', 'unknown event'); return; }

    const EVENT_COLS = 'id, event_id, event_slug, event_title, event_start';
    let { data: event } = await supabase.from('events').select(EVENT_COLS).eq('event_slug', ident).maybeSingle();
    // Separate lookups rather than one `or` filter built from the URL.
    if (!event) ({ data: event } = await supabase.from('events').select(EVENT_COLS).eq('event_id', ident).maybeSingle());
    // A portal that hands over the row's own id rather than its slug.
    if (!event && UUID_RE.test(ident)) ({ data: event } = await supabase.from('events').select(EVENT_COLS).eq('id', ident).maybeSingle());
    if (!event) { sendError(res, 404, 'event_not_found', 'unknown event'); return; }

    const { data: shown } = await supabase
      .from('events_media_upload_links')
      .select('id, expires_at')
      .eq('event_id', event.id)
      .eq('show_gallery', true)
      .eq('is_active', true)
      .limit(20);
    // "Active" means what it means everywhere else (resolveLink): still
    // switched on AND not past its expiry. An organiser who sets a link
    // to expire at the end of the day expects the gallery to close with
    // it, rather than to have to switch it off by hand as well. Checked
    // here rather than in a filter so no timestamp is interpolated.
    let live = (shown ?? []).some((l: { expires_at: string | null }) => (
      !l.expires_at || new Date(l.expires_at).getTime() > Date.now()
    ));

    // The event's registered albums, and the organiser's settings for
    // them. Read before the gate because they are its second arm, and
    // the page below needs them anyway.
    const registered = await registeredAlbums(event.id);
    const slugOf = new Map(registered.map((a) => [a.albumId, a.slug] as [string, string]));
    // Albums an organiser has taken off the portal (migration 016). Their
    // photographs go with them, or hiding an album would hide only its
    // heading.
    const { hidden, enhanced, xray, relit, oldestFirst } = await albumSettings(event.id, slugOf);
    // Registered albums that are not projector views: the ingested ones,
    // in their own order, after the views (which keep the order the day
    // ran). The wedding's view albums never open the gate on their own,
    // so an event with only guest uploads behaves exactly as it did.
    const extras = registered
      .filter((a) => !isView(a.slug))
      .sort((x, y) => (x.sortOrder - y.sortOrder) || (x.name ?? x.slug).localeCompare(y.name ?? y.slug));

    if (!live && extras.length > 0) {
      // Second arm of the gate: an event with no upload link showing a
      // gallery is still live when at least one portal-visible ingested
      // album holds an approved public photograph. Every value in the
      // filter is a registered, shape-checked slug -- nothing of the
      // request reaches it.
      const slugs = extras.filter((a) => !hidden.has(a.slug)).map((a) => a.slug);
      if (slugs.length > 0) {
        const { count } = await supabase
          .from('host_media')
          .select('id', { count: 'exact', head: true })
          .eq('host_kind', 'event')
          .eq('host_id', event.id)
          .eq('access_level', 'public')
          .eq('is_approved', true)
          .or('metadata->>hidden.is.null,metadata->>hidden.neq.true')
          // Parity with the feed query's posted gate: unreachable today
          // (posted:false only occurs in the booth View album, which is
          // never in `slugs`), but keeps the gate and the feed agreeing if
          // that ever changes.
          .or('metadata->>posted.is.null,metadata->>posted.neq.false')
          .in('metadata->>album', slugs);
        live = (count ?? 0) > 0;
      }
    }
    if (!live) { sendError(res, 404, 'event_not_found', 'unknown event'); return; }

    const limit = Math.max(1, Math.min(Number(req.query['limit'] ?? 60) || 60, 200));
    const offset = Math.max(0, Math.min(Number(req.query['offset'] ?? 0) || 0, GALLERY_MAX));
    const askedFor = typeof req.query['album'] === 'string' ? req.query['album'] : '';
    const focusId = typeof req.query['photo'] === 'string' && UUID_RE.test(req.query['photo'])
      ? req.query['photo'] : null;
    // Which end to start at. The viewer's choice if they made one, and
    // one of two words only -- it decides a sort direction, so it is
    // matched against a pair rather than passed anywhere near the query.
    const askedSort = req.query['sort'] === 'oldest' ? 'oldest'
      : req.query['sort'] === 'newest' ? 'newest'
        : null;

    // The views first, in the order the day ran, then the registered
    // albums in theirs -- each less whatever the organiser has hidden.
    const offered: string[] = [
      ...GALLERY_ORDER.filter((v) => !hidden.has(v)),
      ...extras.filter((a) => !hidden.has(a.slug)).map((a) => a.slug),
    ];

    // The album's own names, and the slugs a link is written with.
    const nameOf = new Map<string, string>();
    for (const a of registered) {
      if (a.name) nameOf.set(a.slug, a.name);
    }
    const nameFor = (v: string) => nameOf.get(v) ?? GALLERY_FALLBACK_NAMES[v as View] ?? v;
    const slugFor = (v: string) => slugify(nameFor(v));

    // Which album a fetched row belongs to: its registered slug when it
    // carries one, else its view tag as the feed has always read it.
    const extraSlugs = new Set(extras.map((a) => a.slug));
    const albumOf = (metadata: unknown): string => {
      const tag = metadata && typeof metadata === 'object'
        ? (metadata as Record<string, unknown>)['album']
        : undefined;
      if (typeof tag === 'string' && extraSlugs.has(tag)) return tag;
      return tagView(metadata);
    };

    // An album can be asked for by its slug -- which is what a shared
    // link carries, /photos?album=getting-ready -- or by the view name
    // the projector uses. Neither reaches a query: both are matched
    // against this event's own albums and the result is an offered
    // album's slug or null.
    const wanted = offered.find((v) => slugFor(v) === askedFor || v === askedFor) ?? null;
    if (askedFor && !wanted) { sendError(res, 404, 'album_not_found', 'unknown album'); return; }

    // Newest first unless this album says otherwise, and the viewer
    // overrides either way. Looking at one album takes that album's
    // default; looking at everything at once has no one album to ask, so
    // it stays newest first -- which is what a feed of what has just
    // arrived should be.
    const albumDefault = wanted && oldestFirst.has(slugFor(wanted)) ? 'oldest'
      : wanted && oldestFirst.has(wanted) ? 'oldest'
        : 'newest';
    const sort = askedSort ?? albumDefault;
    const ascending = sort === 'oldest';

    // Which album a photograph is in is read from its own tag rather
    // than from album membership. Membership is what the projector
    // resolves, and resolving it means reading every photograph of the
    // event on every request -- which is what made this page take nine
    // seconds to answer (reported 2026-09-27). The two agree: the tag is
    // written when the photograph lands and the album it joins is chosen
    // from it.
    const blocked = [...(await blockedFor(event.id))];
    // The select comes first: PostgREST's builder has no filters on it
    // until it does (a page of this shipped 500ing on 2026-09-27).
    const base = (columns: string, opts?: { count: 'exact'; head: true }) => {
      let q = supabase
        // The gallery's own view of host_media (migration 028). The only
        // thing it adds is captured_at -- when the photograph was taken,
        // or when it arrived if it does not say -- which is what this
        // page sorts by and which no `order=` can express over JSONB.
        .from('event_media_gallery')
        .select(columns, opts as never)
        .eq('host_kind', 'event')
        .eq('host_id', event.id)
        .eq('access_level', 'public')
        .eq('is_approved', true)
        .or('metadata->>posted.is.null,metadata->>posted.neq.false')
        // Photos an operator has hidden stay out, as they do everywhere.
        .or('metadata->>hidden.is.null,metadata->>hidden.neq.true');
      if (blocked.length > 0) {
        q = q.or(`metadata->>member_id.is.null,metadata->>member_id.not.in.(${blocked.join(',')})`);
      }
      return q;
    };
    // Every value below is one of this event's own offered albums, never
    // the request's: `wanted` was matched against `offered`, and
    // `offered` is the view constants plus registered, shape-checked
    // slugs.
    const inAlbum = (q: { eq: (c: string, v: string) => unknown; in: (c: string, v: string[]) => unknown }) => (
      wanted ? q.eq('metadata->>album', wanted) : q.in('metadata->>album', [...offered])
    );

    const counts = new Map<string, number>();
    const [pageResult] = await Promise.all([
      inAlbum(base('id, storage_path, mime_type, bytes, width, height, variants, metadata, created_at') as never)
        // By when it was taken. A photographer delivers weeks later in
        // one sitting, so ordering by arrival put 851 photographs in
        // whatever order the browser happened to finish them in.
        //
        // Which end it starts at is the album's to say and the viewer's
        // to override (migration 029): a delivered set reads forwards,
        // where a feed of what has just arrived reads backwards. The id
        // tiebreak follows the same direction, or a page boundary could
        // repeat a photograph that shares a second with another.
        .order('captured_at', { ascending })
        .order('id', { ascending })
        .range(offset, offset + limit - 1),
      // One count per album, each a head request that returns no rows.
      ...offered.map(async (v) => {
        const { count } = await base('id', { count: 'exact', head: true }).eq('metadata->>album', v);
        if (count) counts.set(v, count);
      }),
    ]);
    const { data, error } = pageResult as { data: FeedRow[] | null; error: { message: string } | null };
    if (error) {
      logger.error('event gallery failed', { eventId: event.id, error: error.message });
      sendError(res, 500, 'list_failed', 'could not list media');
      return;
    }

    const albums = offered
      .filter((v) => (counts.get(v) ?? 0) > 0)
      .map((v) => ({
        album: v, slug: slugFor(v), name: nameFor(v), count: counts.get(v) ?? 0,
        // Whether this album is showing the enhanced copies, so the page
        // can offer the before-and-after only where there is one.
        enhanced: enhanced.has(v),
        // Whether the selfies behind this album's pictures may be shown.
        xray: xray.has(v),
      }));

    /**
     * One row as the gallery serves it. An album with enhancement on
     * shows the enhanced copy of each photograph that has one; every
     * other album, and every photograph without one, is untouched
     * (asked 2026-09-27). The album's slug rides along so a link to the
     * photograph can carry the album it belongs to.
     */
    const forFeed = (r: FeedRow) => {
      const item = mapFeedItem(r);
      const view = albumOf(r.metadata);
      const better = (r.variants ?? {}) as Record<string, unknown>;
      const withSlug = { ...item, album: view, album_slug: slugFor(view) } as Record<string, unknown>;
      // A selfie is not what anybody posed for. It leaves here only for
      // an album whose organiser has turned x-ray on (asked 2026-09-28).
      if (!xray.has(view)) delete withSlug['selfie'];
      // A booth picture's enhanced copy is of the selfie behind it: the
      // poster was made under imagined light, the selfie in a very dark
      // room (asked 2026-09-28). Shown in place of the selfie, and only
      // where the album asks for enhanced copies.
      // Which improved copy this album asked for. An album set to the
      // model's copy that has not been relit yet falls back to the
      // arithmetic one, so choosing it early shows what is there rather
      // than nothing.
      const pick = (plain: string, ai: string): string | null => {
        if (relit.has(view) && typeof better[ai] === 'string') return better[ai] as string;
        return typeof better[plain] === 'string' ? (better[plain] as string) : null;
      };
      const betterSelfie = pick('enhanced_selfie', 'enhanced_ai_selfie');
      if (xray.has(view) && enhanced.has(view) && betterSelfie && withSlug['selfie']) {
        withSlug['selfie'] = toBrowserUrl(betterSelfie);
        withSlug['selfie_original'] = item.selfie;
        withSlug['selfie_enhanced'] = true;
      }
      const path = enhanced.has(view) ? pick('enhanced', 'enhanced_ai') : null;
      if (!path) return withSlug;
      return {
        ...withSlug,
        url: toBrowserUrl(path),
        enhanced: true,
        variants: { ...withSlug.variants, thumb: toRenderUrl(path, 350), medium: toRenderUrl(path, 800) },
        // The photograph as it was taken, so the difference can be seen
        // by switching rather than by asking again (asked 2026-09-28).
        original: {
          url: withSlug.url,
          thumb: withSlug.variants['thumb'],
          medium: withSlug.variants['medium'],
        },
      };
    };

    // A link to one photograph opens on that photograph, wherever it
    // sits in the album -- page forty of The day is still one link.
    let focus: ReturnType<typeof forFeed> | null = null;
    if (focusId) {
      const { data: one } = await base('id, storage_path, mime_type, bytes, width, height, variants, metadata, created_at')
        .eq('id', focusId)
        .maybeSingle();
      // The same rules as the list: a photograph in an album that is not
      // on the portal is not reachable by knowing its id either.
      const row = (one ?? null) as FeedRow | null;
      if (row && offered.includes(albumOf(row.metadata))) focus = forFeed(row);
    }

    const page = (data ?? []) as FeedRow[];
    const total = wanted
      ? (counts.get(wanted) ?? 0)
      : [...counts.values()].reduce((n, c) => n + c, 0);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      event: {
        id: event.id,
        name: event.event_title ?? null,
        starts_at: event.event_start ?? null,
      },
      albums,
      // The same albums as a sidebar wants them: a label and the path
      // that opens it, under the page's own address. The portal knows
      // nothing about albums -- it asks, and puts what it is given under
      // the page it belongs to (asked 2026-09-28).
      nav: albums.map((a) => ({ label: a.name, path: a.slug, count: a.count })),
      total,
      items: page.map(forFeed),
      focus,
      // Which end this page started at, so the portal can show the
      // switch the right way round without knowing the album's default.
      sort,
      // Where an object lives, with and without the CDN in front of it.
      // Browsing goes through the zone, because that is what it is for;
      // SAVING goes to the origin, because Bunny Optimizer recompresses
      // what it serves and a photograph somebody keeps should not be the
      // lossy one (asked 2026-10-17). The portal swaps one prefix for
      // the other -- both are public hosts serving public objects, so
      // neither is a secret.
      cdn_origin: cdn.zone,
      object_origin: publicSupabaseUrl,
      next_offset: offset + page.length < total ? offset + page.length : null,
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // POST /public/event-media/links/:code/uploads   (mint)
  // ────────────────────────────────────────────────────────────────────
  async function mintUploads(req: Request, res: Response): Promise<void> {
    if (!deps.ticketSecret) {
      sendError(res, 503, 'not_configured', 'uploads are not available right now');
      return;
    }
    const ctx = await resolveLink(req, res, 'mint', GUEST_RATE_LIMITS.mintPerIp);
    if (!ctx) return;
    const { link } = ctx;

    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;

    const clientId = typeof body['client_id'] === 'string' && UUID_RE.test(body['client_id'])
      ? body['client_id']
      : null;
    if (!clientId) {
      sendError(res, 400, 'invalid_request', 'client_id must be a UUID');
      return;
    }
    // A guest with a phone and a photographer with eight thousand files
    // are not the same caller. The photographer's link is given to one
    // professional, so their ceiling is their own.
    if (!(await checkRate(
      res,
      guestRateKey('mint', clientId),
      link.role === 'photographer' ? GUEST_RATE_LIMITS.mintPerPhotographer : GUEST_RATE_LIMITS.mintPerClient,
    ))) return;

    // A photographer's link is one professional with one job, not the QR

    // on the tables: everything it receives is theirs, credited to

    // whoever the organiser named, and kept at the size it arrived.

    const asPhotographer = link.role === 'photographer';


    // A photographer is not on the guest list and is not asked to be.
    // Their link already says who they are, and `identify` refuses any
    // upload on an event that HAS a guest list unless the caller names
    // somebody on it -- which is every wedding worth photographing. Paul
    // Liddement hit exactly that on 2026-10-17: the page loaded, credited
    // him correctly, and then answered every file with "please choose
    // your name from the guest list".
    const who = asPhotographer
      ? ({ ok: true, guest: null } as const)
      : await identify(link.event_id, body['member_id'], clientId);
    if (!who.ok) {
      sendError(res, who.status, who.code, who.message);
      return;
    }
    // The invitation's own name, never what the phone says, when there is
    // one -- and for a photographer, the credit the organiser set, which
    // is the whole point of their link.
    const guestName = asPhotographer
      ? (cleanGuestName(link.credit_name) ?? 'Photographer')
      : who.guest ? who.guest.name : cleanGuestName(body['guest_name']);
    if (link.require_name && !guestName) {
      sendError(res, 400, 'name_required', 'please tell us your name first');
      return;
    }

    const files = Array.isArray(body['files']) ? body['files'] : null;
    if (!files || files.length === 0 || files.length > MAX_FILES_PER_MINT) {
      sendError(res, 400, 'invalid_request', `files must contain 1-${MAX_FILES_PER_MINT} entries`);
      return;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const items: Array<Record<string, unknown>> = [];

    for (const raw of files) {
      const v = validateMintFile(raw, link);
      if (!v.ok) {
        items.push({ filename: v.filename, status: 'failed', error: v.error, message: v.message });
        continue;
      }

      const mediaId = newMediaId();
      const storagePath = buildGuestStoragePath(link.event_id, mediaId, v.file.filename);

      const { data: signed, error: signErr } = await supabase
        .storage.from(storageBucket)
        .createSignedUploadUrl(storagePath);
      if (signErr || !signed?.signedUrl) {
        logger.error('guest mint sign-url failed', { error: signErr?.message });
        items.push({ filename: v.file.filename, status: 'failed', error: 'sign_url_failed', message: 'could not prepare upload' });
        continue;
      }

      const payload: UploadTicketPayload = {
        media_id: mediaId,
        code: link.short_code,
        event_id: link.event_id,
        storage_path: storagePath,
        mime_type: v.file.mime_type,
        max_bytes: v.kind === 'photo' ? link.max_photo_bytes : link.max_video_bytes,
        guest_name: guestName ?? '',
        client_id: clientId,
        captured: v.file.captured,
        booth: v.file.booth,
        // From the link, never from the request: an uploader cannot put
        // their own photographs in the photographer's album by asking.
        photographer: asPhotographer,
        prompt: v.file.prompt ?? null,
        taken_at: v.file.taken_at ?? null,
        member_id: who.guest?.id ?? null,
        exp: nowSeconds + TICKET_TTL_SECONDS,
      };

      items.push({
        filename: v.file.filename,
        status: 'ready',
        media_id: mediaId,
        storage_path: storagePath,
        upload_url: externaliseUrl(signed.signedUrl),
        ticket: mintTicket(payload, deps.ticketSecret),
      });
    }

    const anyFailed = items.some((i) => i['status'] === 'failed');
    res.status(anyFailed ? 207 : 200).json({ items });
  }

  // ────────────────────────────────────────────────────────────────────
  // POST /public/event-media/links/:code/uploads/complete
  // ────────────────────────────────────────────────────────────────────

  // Explicit insert allowlist — nothing from the request body reaches the
  // row except through the verified ticket payload.
  function buildInsertRow(
    p: UploadTicketPayload,
    actualBytes: number,
    autoApprove: boolean,
    eventStart: string | null,
    eveningFromMinutes: number | null,
  ): Record<string, unknown> {
    return {
      id: p.media_id,
      host_kind: 'event',
      host_id: p.event_id,
      storage_path: p.storage_path,
      filename: sanitiseGuestFilename(p.storage_path.split('/').pop() ?? 'file'),
      mime_type: p.mime_type,
      bytes: actualBytes,
      uploaded_by: null,
      access_level: 'public',
      is_approved: autoApprove,
      metadata: {
        source: 'guest',
        // Delivered by the photographer rather than taken by a guest.
        // 'source' stays 'guest' because it means "came through a link",
        // and everything that reads it -- the credit, the uploader
        // filter, who may delete it -- wants that meaning.
        ...(p.photographer ? { photographer: true } : {}),
        upload_link_id: null, // filled by caller (link.id)
        guest_name: p.guest_name || null,
        member_id: p.member_id ?? null,
        client_id: p.client_id,
        captured: p.captured,
        // Which stream this belongs to: the booth's posters on their own,
        // and a guest's photo under Getting ready until the event starts,
        // The day after. The guest never chooses.
        album: albumForUpload({
          photographer: p.photographer === true,
          booth: Boolean(p.booth),
          eventStart,
          now: Date.now(),
          takenAt: typeof p.taken_at === 'string' ? p.taken_at : null,
          eveningFromMinutes,
        }),
        // Kept so an organiser can see why it landed where it did.
        ...(typeof p.taken_at === 'string' && p.taken_at ? { taken_at: p.taken_at } : {}),
        // What the morning asked them for, recorded so a caption can be
        // put under it later.
        ...(readyPrompt(p.prompt)
          ? { prompt: readyPrompt(p.prompt)!.id, prompt_label: readyPrompt(p.prompt)!.label }
          : {}),
      },
    };
  }

  async function headObject(storagePath: string): Promise<{ ok: boolean; bytes: number; contentType: string }> {
    const { data: signed, error } = await supabase
      .storage.from(storageBucket)
      .createSignedUrl(storagePath, 60);
    if (error || !signed?.signedUrl) return { ok: false, bytes: 0, contentType: '' };
    try {
      const resp = await fetch(signed.signedUrl, { method: 'HEAD' });
      if (!resp.ok) return { ok: false, bytes: 0, contentType: '' };
      return {
        ok: true,
        bytes: Number(resp.headers.get('content-length') ?? 0),
        contentType: (resp.headers.get('content-type') ?? '').split(';')[0].trim(),
      };
    } catch {
      return { ok: false, bytes: 0, contentType: '' };
    }
  }

  async function removeObject(storagePath: string | string[]): Promise<void> {
    try {
      const paths = Array.isArray(storagePath) ? storagePath : [storagePath];
      if (paths.length > 0) await supabase.storage.from(storageBucket).remove(paths);
    } catch {
      // best-effort cleanup; the sweep script catches leftovers
    }
  }

  async function completeUploads(req: Request, res: Response): Promise<void> {
    if (!deps.ticketSecret) {
      sendError(res, 503, 'not_configured', 'uploads are not available right now');
      return;
    }
    const ctx = await resolveLink(req, res, 'complete', GUEST_RATE_LIMITS.completePerIp);
    if (!ctx) return;
    const { link, event } = ctx;

    // Hard per-link circuit breaker (client_id is spoofable; this is the
    // real backstop against a leaked QR). Windowed key, NOT the
    // cumulative uploads_count column.
    if (!(await checkRate(
      res,
      guestRateKey('complete_link', link.short_code),
      // A photographer's link is one professional delivering thousands
      // in a sitting, not a leaked QR.
      link.role === 'photographer'
        ? GUEST_RATE_LIMITS.completePerPhotographerHourly
        : GUEST_RATE_LIMITS.completePerLinkHourly,
    ))) return;

    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const tickets = Array.isArray(body['tickets']) ? body['tickets'] : null;
    if (!tickets || tickets.length === 0 || tickets.length > MAX_FILES_PER_MINT) {
      sendError(res, 400, 'invalid_request', `tickets must contain 1-${MAX_FILES_PER_MINT} entries`);
      return;
    }

    const items: Array<Record<string, unknown>> = [];
    let createdCount = 0;
    let ratedClient = false;

    for (const rawTicket of tickets) {
      const verdict = verifyTicket(rawTicket, undefined, deps.ticketSecret);
      if (!verdict.ok) {
        items.push({ media_id: null, status: 'failed', error: verdict.error });
        continue;
      }
      const p = verdict.payload;

      // Ticket must belong to this link (and therefore this event).
      if (p.code !== link.short_code || p.event_id !== link.event_id) {
        items.push({ media_id: p.media_id, status: 'failed', error: 'invalid_ticket' });
        continue;
      }

      // Blocked between minting and finishing: the bytes go, no row is made.
      if (p.member_id && (await blockedFor(link.event_id)).has(p.member_id)) {
        await removeObject(p.storage_path);
        items.push({ media_id: p.media_id, status: 'failed', error: 'guest_blocked' });
        continue;
      }

      // Per-client limit, keyed off the (verified) ticket's client_id.
      if (!ratedClient) {
        ratedClient = true;
        if (!(await checkRate(res, guestRateKey('complete', p.client_id), GUEST_RATE_LIMITS.completePerClient))) return;
      }

      // Idempotent replay: row already exists → return it.
      const { data: existing } = await supabase
        .from('host_media')
        .select('id, storage_path, mime_type, bytes, width, height, variants, metadata, created_at')
        .eq('id', p.media_id)
        .maybeSingle();
      if (existing) {
        items.push({ media_id: p.media_id, status: 'already_created', item: mapFeedItem(existing as FeedRow) });
        continue;
      }

      const head = await headObject(p.storage_path);
      if (!head.ok) {
        items.push({ media_id: p.media_id, status: 'failed', error: 'object_missing' });
        continue;
      }
      if (head.bytes > p.max_bytes * 1.1) {
        await removeObject(p.storage_path);
        items.push({ media_id: p.media_id, status: 'failed', error: 'file_too_large' });
        continue;
      }
      // The client controls the Content-Type header on the signed PUT —
      // this is where the mint-time claim gets enforced. Fail CLOSED on
      // a missing/empty stored Content-Type (security review 2026-09-19).
      if (head.contentType !== p.mime_type) {
        await removeObject(p.storage_path);
        items.push({ media_id: p.media_id, status: 'failed', error: 'mime_mismatch' });
        continue;
      }

      const row = buildInsertRow(
        p, head.bytes || 0, link.auto_approve, event.event_start ?? null,
        await eveningFromFor(link.event_id),
      );
      (row['metadata'] as Record<string, unknown>)['upload_link_id'] = link.id;

      const { data: inserted, error: insErr } = await supabase
        .from('host_media')
        .insert(row)
        .select('id, storage_path, mime_type, bytes, width, height, variants, metadata, created_at')
        .single();
      if (insErr) {
        // A concurrent replay may have won the insert race — re-read.
        const { data: raced } = await supabase
          .from('host_media')
          .select('id, storage_path, mime_type, bytes, width, height, variants, metadata, created_at')
          .eq('id', p.media_id)
          .maybeSingle();
        if (raced) {
          items.push({ media_id: p.media_id, status: 'already_created', item: mapFeedItem(raced as FeedRow) });
        } else {
          logger.error('guest media insert failed', { error: insErr.message });
          items.push({ media_id: p.media_id, status: 'failed', error: 'db_error' });
        }
        continue;
      }

      createdCount += 1;
      items.push({ media_id: p.media_id, status: 'created', item: mapFeedItem(inserted as FeedRow) });

      // Projector layers, but not for a photographer's delivery. Those
      // are the far layer of a parallax effect the professional
      // photographs are never shown with -- their album is off the
      // portal until the organiser has been through it -- and asking an
      // image model to redraw a wedding photographer's frame with the
      // couple removed is several seconds, several megabytes and a few
      // cents per photograph, times the thousands they deliver.
      if (p.mime_type.startsWith('image/') && !p.photographer) {
        processNewImage(p.media_id, p.storage_path);
      }
    }

    if (createdCount > 0) {
      const { error: incErr } = await supabase.rpc('events_media_upload_links_increment', {
        p_link_id: link.id,
        p_n: createdCount,
      });
      if (incErr) logger.warn('uploads_count increment failed', { error: incErr.message });
    }

    const anyFailed = items.some((i) => i['status'] === 'failed');
    res.status(anyFailed ? 207 : 200).json({ items });
  }

  // ────────────────────────────────────────────────────────────────────
  // POST /public/event-media/links/:code/mine
  // A guest's own uploads, so they can undo a mistake. Ownership is
  // the localStorage client_id recorded in metadata at upload time —
  // the same device-identity model the rest of the feature uses. It
  // never leaves that device except in these two request bodies, and
  // it is never echoed back in any listing.
  // ────────────────────────────────────────────────────────────────────
  async function listMine(req: Request, res: Response): Promise<void> {
    const ctx = await resolveLink(req, res, 'mine', GUEST_RATE_LIMITS.mediaListPerIp);
    if (!ctx) return;
    const { link } = ctx;

    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const clientId = typeof body['client_id'] === 'string' && UUID_RE.test(body['client_id'])
      ? body['client_id']
      : null;
    if (!clientId) {
      sendError(res, 400, 'invalid_request', 'client_id must be a UUID');
      return;
    }

    // On an event with a guest list, "Your photos" are the photos of the
    // guest whose name this phone holds -- so switching names and back
    // brings them all back. Otherwise, this phone's own uploads.
    let owner: Record<string, unknown> = { source: 'guest', client_id: clientId };
    if (body['member_id'] !== undefined && (await guestListFor(link.event_id))) {
      const who = await identify(link.event_id, body['member_id'], clientId);
      if (!who.ok) { sendError(res, who.status, who.code, who.message); return; }
      if (who.guest) owner = { source: 'guest', member_id: who.guest.id };
    }

    // Videos are included here even though the projector never shows
    // them — a guest who uploaded the wrong video needs to remove it.
    const { data, error } = await supabase
      // The same view the gallery reads, so "Yours" is in the same order
      // as the album it sits beside (migration 028).
      .from('event_media_gallery')
      .select('id, storage_path, mime_type, bytes, width, height, variants, metadata, created_at, is_approved')
      .eq('host_kind', 'event')
      .eq('host_id', link.event_id)
      .contains('metadata', owner)
      // Unposted booth pictures live in the booth's own carousel, not in
      // the gallery's "Yours".
      .or('metadata->>posted.is.null,metadata->>posted.neq.false')
      .order('captured_at', { ascending: false })
      // Two photographs taken in the same second are common -- three
      // cameras were shooting this wedding -- and without a tiebreak
      // their order is whatever the plan happens to produce.
      .order('id', { ascending: false })
      .limit(200);

    if (error) {
      logger.error('guest mine list failed', { error: error.message });
      sendError(res, 500, 'list_failed', 'could not list your uploads');
      return;
    }

    const rows = (data ?? []) as FeedRow[];
    res.status(200).json({
      items: rows.map((r) => ({
        ...mapFeedItem(r),
        // Pending items are invisible to everyone else until approved;
        // show their owner that they are waiting.
        pending: (r as { is_approved?: boolean }).is_approved === false,
      })),
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // POST /public/event-media/links/:code/mine/delete
  // ────────────────────────────────────────────────────────────────────
  async function deleteMine(req: Request, res: Response): Promise<void> {
    const ctx = await resolveLink(req, res, 'mine', GUEST_RATE_LIMITS.completePerIp);
    if (!ctx) return;
    const { link } = ctx;

    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const clientId = typeof body['client_id'] === 'string' && UUID_RE.test(body['client_id'])
      ? body['client_id']
      : null;
    const mediaId = typeof body['media_id'] === 'string' && UUID_RE.test(body['media_id'])
      ? body['media_id']
      : null;
    if (!clientId || !mediaId) {
      sendError(res, 400, 'invalid_request', 'client_id and media_id must be UUIDs');
      return;
    }
    if (!(await checkRate(res, guestRateKey('delete', clientId), GUEST_RATE_LIMITS.completePerClient))) return;

    const { data: row, error } = await supabase
      .from('host_media')
      .select('id, storage_path, variants, metadata, host_id, host_kind')
      .eq('id', mediaId)
      .maybeSingle();
    if (error) {
      sendError(res, 500, 'fetch_failed', 'could not look up that upload');
      return;
    }

    const meta = (row?.metadata ?? {}) as Record<string, unknown>;
    // Every condition must hold: the row exists, belongs to THIS
    // event, was uploaded by a guest (never an admin's media), and
    // carries this exact client_id. Any mismatch answers the same
    // 404 so this cannot be used to probe for other people's media.
    const owned = row
      && row.host_kind === 'event'
      && row.host_id === link.event_id
      && meta['source'] === 'guest'
      && (await mayManage(link.event_id, meta, clientId));
    if (!owned) {
      sendError(res, 404, 'not_found', 'that upload is not yours to remove');
      return;
    }

    const { error: delErr } = await supabase.from('host_media').delete().eq('id', mediaId);
    if (delErr) {
      logger.error('guest delete failed', { error: delErr.message });
      sendError(res, 500, 'delete_failed', 'could not remove that upload');
      return;
    }

    // Best-effort storage cleanup: the original plus any variants the
    // edge function actually wrote (render-URL fallbacks are not
    // stored objects, so only same-prefix paths are removed).
    const paths = [row.storage_path as string];
    if (typeof meta['selfie'] === 'string' && meta['selfie']) paths.push(meta['selfie']);
    const variants = (row.variants ?? {}) as Record<string, unknown>;
    for (const v of Object.values(variants)) {
      if (typeof v === 'string' && v && !/^https?:\/\//i.test(v)) paths.push(v);
    }
    await removeObject(paths);

    res.status(200).json({ deleted: mediaId });
  }

  // Crash guard: these are the platform's first UNAUTHENTICATED express
  // handlers in module space — an uncaught rejection here would become
  // an unhandledRejection and take the whole API process down (Sentry
  // hook exits). Degrade to a 500 envelope instead.
  function guarded(fn: (req: Request, res: Response) => Promise<void>) {
    return async (req: Request, res: Response): Promise<void> => {
      try {
        await fn(req, res);
      } catch (err) {
        logger.error('guest route crashed', {
          path: req.path,
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          if (!res.headersSent) sendError(res, 500, 'internal_error', 'unexpected failure');
        } catch {
          // response already gone — nothing further to do
        }
      }
    };
  }

  return {
    getLink: guarded(getLink),
    listMedia: guarded(listMedia),
    eventGallery: guarded(eventGallery),
    mintUploads: guarded(mintUploads),
    completeUploads: guarded(completeUploads),
    listMine: guarded(listMine),
    deleteMine: guarded(deleteMine),
    searchGuests: guarded(searchGuests),
    claimGuest: guarded(claimGuest),
    releaseGuest: guarded(releaseGuest),
  };
}

/** An album's name as it appears in a link: "Getting ready" -> getting-ready. */
function slugify(name: string): string {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** The most photographs one gallery request will consider. */
const GALLERY_MAX = 2000;
/** The albums in the order the day ran, which is how they are offered. */
const GALLERY_ORDER: readonly View[] = ['night', 'ready', 'day', 'evening', 'photographer', 'booth', 'elsewhere', 'seed'];
/** Names for an event whose albums were never given one. */
const GALLERY_FALLBACK_NAMES: Record<View, string> = {
  seed: 'Preload',
  night: 'The night before',
  ready: 'Getting ready',
  day: 'The day',
  evening: 'Evening reception',
  photographer: 'Photographer',
  booth: 'Photo booth',
  elsewhere: 'Photo booth elsewhere',
};

export function mountGuestRoutes(router: Router, routes: ReturnType<typeof createGuestRoutes>): void {
  router.get('/public/event-media/links/:code', routes.getLink);
  router.get('/public/event-media/links/:code/media', routes.listMedia);
  // No code: the album view for anyone who opens the page.
  router.get('/public/event-media/events/:identifier/gallery', routes.eventGallery);
  router.get('/public/event-media/links/:code/guests', routes.searchGuests);
  router.post('/public/event-media/links/:code/guests/claim', routes.claimGuest);
  router.post('/public/event-media/links/:code/guests/release', routes.releaseGuest);
  router.post('/public/event-media/links/:code/uploads', routes.mintUploads);
  router.post('/public/event-media/links/:code/uploads/complete', routes.completeUploads);
  // POST, not GET, for both: client_id is the ownership credential and
  // a query string ends up in access logs and browser history.
  router.post('/public/event-media/links/:code/mine', routes.listMine);
  router.post('/public/event-media/links/:code/mine/delete', routes.deleteMine);
}
