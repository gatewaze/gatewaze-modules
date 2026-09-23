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
import { boothEffect, buildPrompt, publicEffects } from '../lib/booth-effects.js';
import { BOOTH_POSES, boothPose, fingerLook, poseChangesAt, poseOfTheHour } from '../lib/booth-poses.js';
import { READY_PROMPTS, readyPrompt, readyWindow } from '../lib/ready-prompts.js';
import { BOOTH_PLACES, DEFAULT_PLACE, boothPlace, placeRail } from '../lib/booth-places.js';
import { plateHasPeople, readFingers, runCardCopy, runCutout, runDepth, runPlate, runStyle, runSwap, styleConfigured, swapConfigured } from '../lib/booth-provider.js';
import { browserObjectUrl, browserSizedUrl, type CdnConfig } from '../lib/cdn.js';
import { albumForUpload, resolveViews, tagView, type View } from '../lib/view-albums.js';
import { parseBoothTheme, type BoothTheme } from '../lib/booth-theme.js';
import { BOOTH_ERAS, eraAllLooks, eraLooks, erasFor, isEraSetting } from '../lib/booth-eras.js';
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
      .select('id, event_id, short_code, label, is_active, expires_at, require_name, allow_video, auto_approve, show_gallery, max_photo_bytes, max_video_bytes, logo_url, allow_face_filter')
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

  // Booth themes (lib/booth-theme.ts), cached per event -- misses too, so
  // an event without one costs one storage read per window rather than
  // one per guest page load.
  const THEME_TTL_MS = 5 * 60_000;
  const THEME_MAX_BYTES = 64 * 1024;
  const themeCache = new Map<string, { at: number; raw: unknown }>();

  async function boothThemeFor(eventId: string, offered: Set<string>): Promise<BoothTheme | null> {
    if (offered.size === 0) return null;
    const dir = `event/${eventId}/booth-theme`;
    let hit = themeCache.get(eventId);
    if (!hit || Date.now() - hit.at > THEME_TTL_MS) {
      let raw: unknown = null;
      try {
        const { data, error } = await supabase.storage.from(storageBucket).download(`${dir}/theme.json`);
        if (!error && data && data.size <= THEME_MAX_BYTES) raw = JSON.parse(await data.text());
      } catch (err) {
        logger.warn('booth theme unreadable', { eventId, error: err instanceof Error ? err.message : String(err) });
      }
      hit = { at: Date.now(), raw };
      themeCache.set(eventId, hit);
    }
    if (hit.raw === null) return null;
    const looksFor = (era: string) => {
      const found = erasFor(era).find((e) => e.key === era);
      return new Set((found ? eraAllLooks(found) : []).filter((id) => offered.has(id)));
    };
    return parseBoothTheme(hit.raw, looksFor, (file) => toBrowserUrl(`${dir}/${file}`));
  }

  /**
   * Board pictures are served as they are.
   *
   * Storage resizing looked like free bandwidth and was not: a width on
   * its own squashes the picture, and `contain` pads it into a square,
   * both of which put people's heads outside the crop (2026-09-23).
   * The pictures themselves are not one shape either -- the model
   * returns 864x1184 for some looks and 1024x1024 for others -- so the
   * page crops them from the top in CSS, where the shape is known, and
   * loads them lazily instead.
   */
  function boardSized(url: string | null): string | null {
    return url;
  }

  /**
   * The illustrated booth as the guest page needs it: the eras this event
   * offers (all, or the one it is themed on), each with its artwork and
   * its six looks. Only eras the theme has an interior for are offered.
   */
  async function boothFor(
    eventId: string,
    effects: Array<{ id: string; label: string; blurb: string }>,
  ) {
    const offered = new Set(effects.map((e) => e.id));
    const theme = await boothThemeFor(eventId, offered);
    if (!theme) return null;
    const { data: settings } = await supabase
      .from('events_media_booth_settings')
      .select('era, pose_mode, pose_minutes, pose_offset, fingers_pick')
      .eq('event_id', eventId)
      .maybeSingle();
    const setting = isEraSetting(settings?.era) ? settings!.era : 'all';
    // Poses (migration 012). Everything a booth or a projector needs to
    // work out for itself which pose is being asked for right now.
    const poseMode = settings?.pose_mode === 'hour' || settings?.pose_mode === 'card' ? settings.pose_mode : 'off';
    const poseMinutes = Number.isInteger(settings?.pose_minutes) ? Math.min(240, Math.max(5, settings!.pose_minutes)) : 30;
    const now = new Date();
    const current = poseMode === 'hour'
      ? poseOfTheHour(now, poseMinutes, Number.isInteger(settings?.pose_offset) ? settings!.pose_offset : 0)
      : null;
    const poses = {
      mode: poseMode,
      minutes: poseMinutes,
      fingers: settings?.fingers_pick === true,
      current: current ? { id: current.id, label: current.label, instruction: current.instruction } : null,
      changes_at: poseMode === 'hour' ? poseChangesAt(now, poseMinutes).toISOString() : null,
      next: poseMode === 'hour'
        ? (() => {
          const n = poseOfTheHour(poseChangesAt(now, poseMinutes), poseMinutes,
            Number.isInteger(settings?.pose_offset) ? settings!.pose_offset : 0);
          return { id: n.id, label: n.label, instruction: n.instruction };
        })()
        : null,
      // The whole deck, for the booth that deals its own card.
      all: poseMode === 'card'
        ? BOOTH_POSES.map((p) => ({ id: p.id, label: p.label, instruction: p.instruction, group: p.group === true }))
        : [],
    };
    const byId = new Map(effects.map((e) => [e.id, e]));
    const eras = erasFor(setting)
      .filter((era) => theme.eras[era.key])
      .map((era) => {
        const art = theme.eras[era.key]!;
        return {
          key: era.key,
          label: era.label,
          blurb: era.blurb,
          card: art.card,
          interior: art.interior,
          interiorLandscape: art.interior_landscape,
          board: art.board,
          // A board per place: a decade is not the same thing in Britain
          // as in America, so each country has its own six looks.
          looks: (['uk', 'us'] as const).reduce((acc, p) => {
            acc[p] = eraLooks(era, p)
              .filter((id) => byId.has(id))
              .map((id) => ({ ...byId.get(id)!, sample: boardSized(art.samples[id] ?? null) }));
            return acc;
          }, {} as Record<'uk' | 'us', Array<{ id: string; label: string; blurb: string; sample: string | null }>>),
        };
      })
      .filter((era) => era.looks.uk.length > 0 || era.looks.us.length > 0);
    if (eras.length === 0) return null;
    const keys = new Set(eras.map((e) => e.key));
    const picker = theme.picker
      ? { ...theme.picker, tiles: theme.picker.tiles.filter((t) => keys.has(t.key)) }
      : null;
    return {
      picker: picker && picker.tiles.length > 0 ? picker : null,
      eras,
      poses,
      // Britain or America: the same decades, each country's version
      // (lib/booth-places.ts).
      places: { options: BOOTH_PLACES, default: DEFAULT_PLACE },
    };
  }


  // ────────────────────────────────────────────────────────────────────
  // GET /public/event-media/links/:code
  // ────────────────────────────────────────────────────────────────────
  async function getLink(req: Request, res: Response): Promise<void> {
    const ctx = await resolveLink(req, res, 'resolve', GUEST_RATE_LIMITS.resolvePerIp);
    if (!ctx) return;
    const { link, event } = ctx;

    // Face filters are only offered when the deployment has a provider
    // AND this link allows them — otherwise the guest never sees it.
    let faceFilters: Array<{ id: string; label: string; preview: string }> = [];
    if (link.allow_face_filter && swapConfigured()) {
      const { data: rows } = await supabase
        .from('events_media_face_filters')
        .select('id, label, source_path')
        .eq('event_id', link.event_id)
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
        .limit(12);
      faceFilters = (rows ?? []).map((r: { id: string; label: string; source_path: string }) => ({
        id: r.id,
        label: r.label,
        preview: toPublicUrl(r.source_path),
      }));
    }

    const boothEffects = link.allow_face_filter && styleConfigured() ? publicEffects() : [];
    const booth = await boothFor(link.event_id, boothEffects);

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
      },
      face_filters: faceFilters,
      // Style effects need no per-event setup, so they turn on with the
      // provider — unlike swaps, which need reference faces uploaded.
      booth_effects: boothEffects,
      // The illustrated booth, when this event has one; null otherwise.
      booth,
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

  async function generateLayers(mediaId: string, storagePath: string): Promise<void> {
    try {
      const src = toPublicUrl(storagePath);

      // Browse-card copy lives in metadata rather than storage — it is a
      // few short strings, not a file. Started BEFORE the layers and
      // never awaited alongside them: it is the only one of these the
      // guest actually reads, and it used to be skipped entirely
      // whenever a layer threw.
      void (async () => {
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
   * layers and browse copy, and its thumbnails. Fire-and-forget.
   */
  function processNewImage(mediaId: string, storagePath: string): void {
    void generateLayers(mediaId, storagePath);
    // invoke() resolves { data, error } on a non-2xx rather than
    // rejecting, so the error envelope must be checked or edge-fn
    // failures are invisible (evidence review 2026-09-19, F4).
    void supabase.functions
      .invoke('media-process-image', { body: { mediaId, table: 'host_media' } })
      .then(({ error }: { error: { message?: string } | null }) => {
        if (error) {
          logger.warn('media-process-image returned an error', { mediaId, error: error.message ?? String(error) });
        }
      })
      .catch((err: unknown) => {
        logger.warn('media-process-image invoke failed', {
          mediaId, error: err instanceof Error ? err.message : String(err),
        });
      });
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

  function mapFeedItem(r: FeedRow, view?: View) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const variants: Record<string, string> = {};
    if (r.variants && typeof r.variants === 'object') {
      for (const [k, v] of Object.entries(r.variants)) {
        if (typeof v === 'string' && v) variants[k] = toBrowserUrl(v);
      }
    }
    // Fill missing variants with on-the-fly render URLs: the magick-wasm
    // edge fn cannot decode multi-MP photos inside the edge memory
    // ceiling (WORKER_RESOURCE_LIMIT, live 2026-09-20), but this
    // project's imgproxy transformation endpoint resizes anything —
    // so every photo gets a thumb/medium regardless of the fn's fate.
    if (r.mime_type.startsWith('image/')) {
      if (!variants['thumb']) variants['thumb'] = toRenderUrl(r.storage_path, 350);
      if (!variants['medium']) variants['medium'] = toRenderUrl(r.storage_path, 800);
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
    if (!(await checkRate(res, guestRateKey('mint', clientId), GUEST_RATE_LIMITS.mintPerClient))) return;

    const who = await identify(link.event_id, body['member_id'], clientId);
    if (!who.ok) {
      sendError(res, who.status, who.code, who.message);
      return;
    }
    // The invitation's own name, never what the phone says, when there is one.
    const guestName = who.guest ? who.guest.name : cleanGuestName(body['guest_name']);
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
        prompt: v.file.prompt ?? null,
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
        upload_link_id: null, // filled by caller (link.id)
        guest_name: p.guest_name || null,
        member_id: p.member_id ?? null,
        client_id: p.client_id,
        captured: p.captured,
        // Which stream this belongs to: the booth's posters on their own,
        // and a guest's photo under Getting ready until the event starts,
        // The day after. The guest never chooses.
        album: albumForUpload({ booth: Boolean(p.booth), eventStart, now: Date.now() }),
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
      GUEST_RATE_LIMITS.completePerLinkHourly,
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

      const row = buildInsertRow(p, head.bytes || 0, link.auto_approve, event.event_start ?? null);
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

      if (p.mime_type.startsWith('image/')) processNewImage(p.media_id, p.storage_path);
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
      .from('host_media')
      .select('id, storage_path, mime_type, bytes, width, height, variants, metadata, created_at, is_approved')
      .eq('host_kind', 'event')
      .eq('host_id', link.event_id)
      .contains('metadata', owner)
      // Unposted booth pictures live in the booth's own carousel, not in
      // the gallery's "Yours".
      .or('metadata->>posted.is.null,metadata->>posted.neq.false')
      .order('created_at', { ascending: false })
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

  // ────────────────────────────────────────────────────────────────────
  // POST /public/event-media/links/:code/booth
  //
  // Applies one booth effect — a reference-face swap or a whole-scene
  // restyle — to the guest's freshly taken photo. Somebody's face is
  // being altered, so this is opt-in per deployment, per link and per tap.
  //
  // Every picture it makes is KEPT: stored and recorded against the
  // guest's device, but marked unposted, which keeps it off the projector
  // and out of the gallery until the guest presses "Put it on the big
  // screen" (POST .../booth/post). The response carries a URL rather than
  // the image itself: holding every picture in memory as base64 is what
  // would have run the API out of memory with a room full of guests.
  // Clients from before this ask for `return: 'url'`; anything else gets
  // the inline image as before, so a page open across the deploy keeps
  // working.
  // ────────────────────────────────────────────────────────────────────
  async function faceFilter(req: Request, res: Response): Promise<void> {
    const ctx = await resolveLink(req, res, 'facefilter', GUEST_RATE_LIMITS.mintPerIp);
    if (!ctx) return;
    const { link } = ctx;

    if (!link.allow_face_filter || (!styleConfigured() && !swapConfigured())) {
      sendError(res, 404, 'not_available', 'the photo booth is not enabled for this link');
      return;
    }

    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const clientId = typeof body['client_id'] === 'string' && UUID_RE.test(body['client_id'])
      ? body['client_id']
      : null;
    // Two shapes of request, one handler: `filter_id` puts a reference
    // face on the guest, `effect` restyles the whole scene. Exactly one
    // must be present, so a malformed request cannot silently do the
    // other thing.
    const filterId = typeof body['filter_id'] === 'string' && UUID_RE.test(body['filter_id'])
      ? body['filter_id']
      : null;
    let effect = typeof body['effect'] === 'string' ? boothEffect(body['effect']) : null;
    // What the booth asked them to do, if anything: the prompt has to be
    // told, or the model tidies the pose away.
    const pose = boothPose(body['pose']);
    // "Hold up one to five fingers": the photo chooses its own look from
    // the decade the guest is standing in.
    const wantsFingers = body['fingers'] === true;
    // Whose version of the decade (lib/booth-places.ts); British unless
    // the guest says otherwise.
    const place = boothPlace(body['place']);
    const era = typeof body['decade'] === 'string' ? BOOTH_ERAS.find((e) => e.key === body['decade']) ?? null : null;
    // The guest's photo arrives as a data URL from the camera step so
    // it never has to be published before they have seen the result.
    const dataUrl = typeof body['image'] === 'string' ? body['image'] : '';
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!clientId || !m || (filterId === null) === (effect === null)) {
      sendError(res, 400, 'invalid_request',
        'client_id, a base64 image and exactly one of effect or filter_id are required');
      return;
    }
    if (effect && (effect.kind !== 'style' || !effect.style || !styleConfigured())) {
      sendError(res, 404, 'not_available', 'that effect is not available');
      return;
    }
    if (filterId && !swapConfigured()) {
      sendError(res, 404, 'not_available', 'face swaps are not available');
      return;
    }
    const mimeType = m[1]!;
    const bytes = Buffer.from(m[2]!, 'base64');
    if (bytes.length === 0 || bytes.length > 12 * 1024 * 1024) {
      sendError(res, 400, 'file_too_large', 'that photo is too large to filter');
      return;
    }

    // Generation costs money per call, so it is capped harder than
    // anything else on the guest path — per device AND per link.
    // Who, before anything is spent on a model call.
    const who = await identify(link.event_id, body['member_id'], clientId);
    if (!who.ok) {
      sendError(res, who.status, who.code, who.message);
      return;
    }

    if (!(await checkRate(res, guestRateKey('facefilter', clientId), GUEST_RATE_LIMITS.faceFilterPerClient))) return;
    if (!(await checkRate(res, guestRateKey('facefilter_burst', link.short_code), GUEST_RATE_LIMITS.faceFilterPerLinkBurst))) return;
    if (!(await checkRate(res, guestRateKey('facefilter_link', link.short_code), GUEST_RATE_LIMITS.faceFilterPerLinkHourly))) return;

    let filter: { id: string; label: string; source_path: string } | null = null;
    if (filterId) {
      const { data } = await supabase
        .from('events_media_face_filters')
        .select('id, label, source_path, is_active, event_id')
        .eq('id', filterId)
        .maybeSingle();
      if (!data || !data.is_active || data.event_id !== link.event_id) {
        sendError(res, 404, 'not_available', 'unknown filter');
        return;
      }
      filter = data;
    }

    // Both images must be fetchable by the provider. The guest's photo
    // goes to a scratch path that no gallery row ever references, and
    // is removed again as soon as the swap returns.
    const scratchId = newMediaId();
    const scratchPath = `event/${link.event_id}/__filter/${scratchId}.jpg`;
    const { error: upErr } = await supabase.storage
      .from(storageBucket)
      .upload(scratchPath, bytes, { contentType: mimeType, upsert: false });
    if (upErr) {
      logger.error('face filter scratch upload failed', { error: upErr.message });
      sendError(res, 500, 'filter_failed', 'could not prepare that photo');
      return;
    }

    try {
      // Fingers first: what they held up decides which look is made.
      // A hand nobody can read, or none at all, keeps the look they
      // chose on the way in, so a photo is never wasted on a misread.
      let fingers: number | null = null;
      if (wantsFingers && era && effect) {
        fingers = await readFingers(toPublicUrl(scratchPath));
        const chosen = fingers === null ? null : boothEffect(fingerLook(fingers, eraLooks(era, place)) ?? '');
        if (chosen && chosen.kind === 'style' && chosen.style) effect = chosen;
      }
      const result = filter
        ? await runSwap(toPublicUrl(filter.source_path), toPublicUrl(scratchPath))
        : await runStyle(
          toPublicUrl(scratchPath),
          // The decade the look belongs to decides which rail applies.
          buildPrompt(effect!, pose?.prompt ?? null,
            placeRail(BOOTH_ERAS.find((e) => eraAllLooks(e).includes(effect!.id))?.key ?? null, place)),
        );
      if (!result.ok) {
        const status = result.error === 'no_face' ? 422 : result.error === 'timeout' ? 504 : 502;
        if (result.error !== 'no_face') {
          logger.warn('booth effect failed', {
            effect: filter ? `swap:${filter.id}` : effect!.id,
            error: result.error,
            detail: result.detail,
          });
        }
        sendError(res, status, result.error, result.error === 'no_face'
          ? 'we could not find a face in that photo'
          : 'that effect could not be applied right now');
        return;
      }

      const kept = await keepBoothPicture({
        link,
        clientId,
        guestName: who.guest ? who.guest.name : cleanGuestName(body['guest_name']),
        memberId: who.guest?.id ?? null,
        image: result.image,
        contentType: result.contentType,
        look: filter ? `Be ${filter.label}` : effect!.label,
        lookId: filter ? `filter:${filter.id}` : effect!.id,
        selfie: bytes,
        selfieType: mimeType,
        pose: pose ? { id: pose.id, label: pose.label } : null,
        place,
      });
      const wantsUrl = body['return'] === 'url';
      res.status(200).json({
        filter: filter ? { id: filter.id, label: filter.label } : null,
        effect: effect ? { id: effect.id, label: effect.label } : null,
        pose: pose ? { id: pose.id, label: pose.label } : null,
        place,
        // What the booth read in their hand, so it can say so.
        fingers,
        media_id: kept?.mediaId ?? null,
        image_url: kept?.url ?? null,
        // Inline only for an older page, or if keeping it failed.
        ...(wantsUrl && kept
          ? {}
          : { image: `data:${result.contentType};base64,${Buffer.from(result.image).toString('base64')}` }),
      });
    } finally {
      await removeObject(scratchPath);
    }
  }

  /**
   * Store a booth picture and record it, unposted, against the guest's
   * device. Returns null if either step fails; the guest still gets their
   * picture, inline, and simply cannot delete it from the event later.
   */
  async function keepBoothPicture(opts: {
    link: UploadLinkRow;
    clientId: string;
    guestName: string | null;
    memberId: string | null;
    image: Uint8Array | Buffer;
    contentType: string;
    look: string;
    lookId: string;
    pose?: { id: string; label: string } | null;
    place?: string | null;
    /**
     * The photograph the guest actually took. Kept beside the picture it
     * became, so an organiser can see both (asked 2026-09-23); it goes
     * when the picture goes.
     */
    selfie?: Uint8Array | Buffer | null;
    selfieType?: string | null;
  }): Promise<{ mediaId: string; url: string } | null> {
    const { link } = opts;
    const mediaId = newMediaId();
    const ext = opts.contentType === 'image/png' ? 'png' : opts.contentType === 'image/webp' ? 'webp' : 'jpg';
    const storagePath = `event/${link.event_id}/${mediaId}/booth.${ext}`;
    const bytes = Buffer.from(opts.image);
    const { error: upErr } = await supabase.storage
      .from(storageBucket)
      .upload(storagePath, bytes, { contentType: opts.contentType, upsert: false });
    if (upErr) {
      logger.error('booth picture store failed', { error: upErr.message });
      return null;
    }
    // The selfie it was made from, beside it. Best effort: a picture
    // without its selfie is still a picture.
    let selfiePath: string | null = null;
    if (opts.selfie) {
      const selfieExt = opts.selfieType === 'image/png' ? 'png' : opts.selfieType === 'image/webp' ? 'webp' : 'jpg';
      const path = `event/${link.event_id}/${mediaId}/selfie.${selfieExt}`;
      const { error } = await supabase.storage
        .from(storageBucket)
        .upload(path, Buffer.from(opts.selfie), { contentType: opts.selfieType || 'image/jpeg', upsert: true });
      if (error) logger.warn('selfie store failed', { mediaId, error: error.message });
      else selfiePath = path;
    }
    const { error: insErr } = await supabase.from('host_media').insert({
      id: mediaId,
      host_kind: 'event',
      host_id: link.event_id,
      storage_path: storagePath,
      filename: `booth.${ext}`,
      mime_type: opts.contentType,
      bytes: bytes.length,
      uploaded_by: null,
      access_level: 'public',
      is_approved: link.auto_approve,
      metadata: {
        source: 'guest',
        upload_link_id: link.id,
        guest_name: opts.guestName,
        member_id: opts.memberId,
        client_id: opts.clientId,
        captured: true,
        album: 'booth',
        look: opts.look,
        look_id: opts.lookId,
        // What the booth asked them to do, when it asked for anything.
        ...(opts.pose ? { pose: opts.pose.id, pose_label: opts.pose.label } : {}),
        ...(opts.place ? { place: opts.place } : {}),
        // What the guest actually took, for the organiser to look at.
        ...(selfiePath ? { selfie: selfiePath } : {}),
        // Off the projector and out of the gallery until the guest posts it.
        posted: false,
      },
    });
    if (insErr) {
      logger.error('booth picture record failed', { error: insErr.message });
      await removeObject(storagePath);
      return null;
    }
    return { mediaId, url: toBrowserUrl(storagePath) };
  }

  // ────────────────────────────────────────────────────────────────────
  // POST /public/event-media/links/:code/booth/post
  // The guest puts one of their kept booth pictures on the big screen.
  // ────────────────────────────────────────────────────────────────────
  async function postBooth(req: Request, res: Response): Promise<void> {
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
    if (!(await checkRate(res, guestRateKey('booth_post', clientId), GUEST_RATE_LIMITS.completePerClient))) return;

    const { data: row, error } = await supabase
      .from('host_media')
      .select('id, storage_path, metadata, host_id, host_kind')
      .eq('id', mediaId)
      .maybeSingle();
    if (error) {
      sendError(res, 500, 'fetch_failed', 'could not look up that picture');
      return;
    }
    const meta = (row?.metadata ?? {}) as Record<string, unknown>;
    // The same ownership test as deleting: this event, a guest's, this
    // device's -- and one of the booth's kept pictures. One 404 for all.
    const owned = row
      && row.host_kind === 'event'
      && row.host_id === link.event_id
      && meta['source'] === 'guest'
      && meta['album'] === 'booth'
      && 'posted' in meta
      && (await mayManage(link.event_id, meta, clientId));
    if (!owned) {
      sendError(res, 404, 'not_found', 'that picture is not yours to post');
      return;
    }
    if (meta['posted'] === true) {
      res.status(200).json({ posted: mediaId, already: true });
      return;
    }
    if (typeof meta['member_id'] === 'string' && (await blockedFor(link.event_id)).has(meta['member_id'])) {
      sendError(res, 403, 'guest_blocked', 'uploads are paused for this guest');
      return;
    }

    // Posting is when it arrives: the projector takes new photos by time,
    // so the picture is dated now, not when it was made.
    const { error: updErr } = await supabase
      .from('host_media')
      .update({ metadata: { ...meta, posted: true }, created_at: new Date().toISOString() })
      .eq('id', mediaId);
    if (updErr) {
      logger.error('booth post failed', { error: updErr.message });
      sendError(res, 500, 'post_failed', 'could not post that picture');
      return;
    }

    // Layers and thumbnails only for pictures that will be shown.
    processNewImage(mediaId, row.storage_path as string);
    const { error: incErr } = await supabase.rpc('events_media_upload_links_increment', { p_link_id: link.id, p_n: 1 });
    if (incErr) logger.warn('uploads_count increment failed', { error: incErr.message });

    res.status(200).json({ posted: mediaId });
  }

  // ────────────────────────────────────────────────────────────────────
  // POST /public/event-media/links/:code/booth/unpost
  // The guest takes one of their booth pictures back off the big screen.
  // It stays kept -- on their phone and in the event -- just unposted.
  // ────────────────────────────────────────────────────────────────────
  async function unpostBooth(req: Request, res: Response): Promise<void> {
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
    if (!(await checkRate(res, guestRateKey('booth_post', clientId), GUEST_RATE_LIMITS.completePerClient))) return;

    const { data: row, error } = await supabase
      .from('host_media')
      .select('id, metadata, host_id, host_kind')
      .eq('id', mediaId)
      .maybeSingle();
    if (error) {
      sendError(res, 500, 'fetch_failed', 'could not look up that picture');
      return;
    }
    const meta = (row?.metadata ?? {}) as Record<string, unknown>;
    // Same test as posting, less the kept-picture condition: a booth
    // picture posted by an older page (uploaded rather than kept) can be
    // taken down too.
    const owned = row
      && row.host_kind === 'event'
      && row.host_id === link.event_id
      && meta['source'] === 'guest'
      && meta['album'] === 'booth'
      && (await mayManage(link.event_id, meta, clientId));
    if (!owned) {
      sendError(res, 404, 'not_found', 'that picture is not yours to take down');
      return;
    }
    if (meta['posted'] === false) {
      res.status(200).json({ unposted: mediaId, already: true });
      return;
    }
    const { error: updErr } = await supabase
      .from('host_media')
      .update({ metadata: { ...meta, posted: false } })
      .eq('id', mediaId);
    if (updErr) {
      logger.error('booth unpost failed', { error: updErr.message });
      sendError(res, 500, 'unpost_failed', 'could not take that picture down');
      return;
    }
    res.status(200).json({ unposted: mediaId });
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
    mintUploads: guarded(mintUploads),
    completeUploads: guarded(completeUploads),
    listMine: guarded(listMine),
    deleteMine: guarded(deleteMine),
    faceFilter: guarded(faceFilter),
    postBooth: guarded(postBooth),
    unpostBooth: guarded(unpostBooth),
    searchGuests: guarded(searchGuests),
    claimGuest: guarded(claimGuest),
    releaseGuest: guarded(releaseGuest),
  };
}

export function mountGuestRoutes(router: Router, routes: ReturnType<typeof createGuestRoutes>): void {
  router.get('/public/event-media/links/:code', routes.getLink);
  router.get('/public/event-media/links/:code/media', routes.listMedia);
  router.get('/public/event-media/links/:code/guests', routes.searchGuests);
  router.post('/public/event-media/links/:code/guests/claim', routes.claimGuest);
  router.post('/public/event-media/links/:code/guests/release', routes.releaseGuest);
  router.post('/public/event-media/links/:code/uploads', routes.mintUploads);
  router.post('/public/event-media/links/:code/uploads/complete', routes.completeUploads);
  // POST, not GET, for both: client_id is the ownership credential and
  // a query string ends up in access logs and browser history.
  router.post('/public/event-media/links/:code/mine', routes.listMine);
  router.post('/public/event-media/links/:code/mine/delete', routes.deleteMine);
  // `/booth` is the current spelling; `/face-filter` is kept because
  // phones that already have the page open are still posting to it.
  router.post('/public/event-media/links/:code/booth', routes.faceFilter);
  router.post('/public/event-media/links/:code/booth/post', routes.postBooth);
  router.post('/public/event-media/links/:code/booth/unpost', routes.unpostBooth);
  router.post('/public/event-media/links/:code/face-filter', routes.faceFilter);
}
