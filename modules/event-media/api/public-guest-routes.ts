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
import { faceSwapConfigured, runFaceSwap } from '../lib/face-swap.js';
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
      .select('id, event_id, event_slug, event_title')
      .eq('id', link.event_id)
      .maybeSingle();
    if (evErr || !event) {
      sendError(res, 404, 'link_not_found', 'unknown upload link');
      return null;
    }

    res.setHeader('Cache-Control', 'no-store');
    return { link: link as UploadLinkRow, event: event as EventRow };
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
    if (link.allow_face_filter && faceSwapConfigured()) {
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

    res.status(200).json({
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
      },
      settings: {
        require_name: link.require_name,
        allow_video: link.allow_video,
        show_gallery: link.show_gallery,
        max_photo_bytes: link.max_photo_bytes,
        max_video_bytes: link.max_video_bytes,
      },
      face_filters: faceFilters,
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

  /** Supabase image-transformation URL (imgproxy render endpoint). */
  function toRenderUrl(storagePath: string, width: number): string {
    return `${publicSupabaseUrl}/storage/v1/render/image/public/${storageBucket}/${storagePath}?width=${width}&resize=contain&quality=80`;
  }

  function mapFeedItem(r: FeedRow) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const variants: Record<string, string> = {};
    if (r.variants && typeof r.variants === 'object') {
      for (const [k, v] of Object.entries(r.variants)) {
        if (typeof v === 'string' && v) variants[k] = toPublicUrl(v);
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
      url: toPublicUrl(r.storage_path),
      mime_type: r.mime_type,
      width: r.width,
      height: r.height,
      variants,
      guest_name: meta['source'] === 'guest' && typeof meta['guest_name'] === 'string' ? meta['guest_name'] : null,
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
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

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

    const rows = (data ?? []) as FeedRow[];
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit && !after;
    const last = page[page.length - 1];
    res.status(200).json({
      items: page.map(mapFeedItem),
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

    const guestName = cleanGuestName(body['guest_name']);
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
  function buildInsertRow(p: UploadTicketPayload, actualBytes: number, autoApprove: boolean): Record<string, unknown> {
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
        client_id: p.client_id,
        captured: p.captured,
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
    const { link } = ctx;

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

      const row = buildInsertRow(p, head.bytes || 0, link.auto_approve);
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

      if (p.mime_type.startsWith('image/')) {
        // Fire-and-forget variant generation. invoke() resolves
        // { data, error } on a non-2xx rather than rejecting, so the
        // error envelope must be checked or edge-fn failures are
        // invisible (evidence review 2026-09-19, F4).
        void supabase.functions
          .invoke('media-process-image', { body: { mediaId: p.media_id, table: 'host_media' } })
          .then(({ error }: { error: { message?: string } | null }) => {
            if (error) {
              logger.warn('media-process-image returned an error', {
                mediaId: p.media_id,
                error: error.message ?? String(error),
              });
            }
          })
          .catch((err: unknown) => {
            logger.warn('media-process-image invoke failed', {
              mediaId: p.media_id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
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

    // Videos are included here even though the projector never shows
    // them — a guest who uploaded the wrong video needs to remove it.
    const { data, error } = await supabase
      .from('host_media')
      .select('id, storage_path, mime_type, bytes, width, height, variants, metadata, created_at, is_approved')
      .eq('host_kind', 'event')
      .eq('host_id', link.event_id)
      .contains('metadata', { source: 'guest', client_id: clientId })
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
      && meta['client_id'] === clientId;
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
    const variants = (row.variants ?? {}) as Record<string, unknown>;
    for (const v of Object.values(variants)) {
      if (typeof v === 'string' && v && !/^https?:\/\//i.test(v)) paths.push(v);
    }
    await removeObject(paths);

    res.status(200).json({ deleted: mediaId });
  }

  // ────────────────────────────────────────────────────────────────────
  // POST /public/event-media/links/:code/face-filter
  //
  // Preview-only: swaps the reference face onto the guest's freshly
  // taken selfie and hands back a TEMPORARY image. Nothing is added to
  // the gallery here — the guest still has to choose to upload it, and
  // can always keep their original instead. Somebody's face is being
  // altered, so this is opt-in per deployment, per link and per tap.
  // ────────────────────────────────────────────────────────────────────
  async function faceFilter(req: Request, res: Response): Promise<void> {
    const ctx = await resolveLink(req, res, 'facefilter', GUEST_RATE_LIMITS.mintPerIp);
    if (!ctx) return;
    const { link } = ctx;

    if (!link.allow_face_filter || !faceSwapConfigured()) {
      sendError(res, 404, 'not_available', 'filters are not enabled for this link');
      return;
    }

    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const clientId = typeof body['client_id'] === 'string' && UUID_RE.test(body['client_id'])
      ? body['client_id']
      : null;
    const filterId = typeof body['filter_id'] === 'string' && UUID_RE.test(body['filter_id'])
      ? body['filter_id']
      : null;
    // The guest's photo arrives as a data URL from the camera step so
    // it never has to be published before they have seen the result.
    const dataUrl = typeof body['image'] === 'string' ? body['image'] : '';
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!clientId || !filterId || !m) {
      sendError(res, 400, 'invalid_request', 'client_id, filter_id and a base64 image are required');
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
    if (!(await checkRate(res, guestRateKey('facefilter', clientId), GUEST_RATE_LIMITS.faceFilterPerClient))) return;
    if (!(await checkRate(res, guestRateKey('facefilter_link', link.short_code), GUEST_RATE_LIMITS.faceFilterPerLinkHourly))) return;

    const { data: filter } = await supabase
      .from('events_media_face_filters')
      .select('id, label, source_path, is_active, event_id')
      .eq('id', filterId)
      .maybeSingle();
    if (!filter || !filter.is_active || filter.event_id !== link.event_id) {
      sendError(res, 404, 'not_available', 'unknown filter');
      return;
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
      const result = await runFaceSwap(toPublicUrl(filter.source_path), toPublicUrl(scratchPath));
      if (!result.ok) {
        const status = result.error === 'no_face' ? 422 : result.error === 'timeout' ? 504 : 502;
        if (result.error !== 'no_face') {
          logger.warn('face swap failed', { error: result.error, detail: result.detail });
        }
        sendError(res, status, result.error, result.error === 'no_face'
          ? 'we could not find a face in that photo'
          : 'the filter could not be applied right now');
        return;
      }

      // Hand the preview back inline: it exists only in the guest's
      // browser until they choose to upload it.
      res.status(200).json({
        filter: { id: filter.id, label: filter.label },
        image: `data:${result.contentType};base64,${Buffer.from(result.image).toString('base64')}`,
      });
    } finally {
      await removeObject(scratchPath);
    }
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
  };
}

export function mountGuestRoutes(router: Router, routes: ReturnType<typeof createGuestRoutes>): void {
  router.get('/public/event-media/links/:code', routes.getLink);
  router.get('/public/event-media/links/:code/media', routes.listMedia);
  router.post('/public/event-media/links/:code/uploads', routes.mintUploads);
  router.post('/public/event-media/links/:code/uploads/complete', routes.completeUploads);
  // POST, not GET, for both: client_id is the ownership credential and
  // a query string ends up in access logs and browser history.
  router.post('/public/event-media/links/:code/mine', routes.listMine);
  router.post('/public/event-media/links/:code/mine/delete', routes.deleteMine);
  router.post('/public/event-media/links/:code/face-filter', routes.faceFilter);
}
