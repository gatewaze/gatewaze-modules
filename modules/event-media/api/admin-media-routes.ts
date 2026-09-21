// @ts-nocheck — depends on @supabase/supabase-js + express which require
// pnpm install at the modules workspace level.
/**
 * Admin edits to a photo's own event-media data.
 *
 *   PUT /admin/events/:eventId/media/:mediaId/card   replace the Wedflix card
 *
 * Why this is not the generic host-media PATCH: the card lives in the
 * photo's `metadata`, beside its album, its hidden flag and the guest
 * who uploaded it. Letting the browser write `metadata` would let one
 * careless save wipe those. This route reads ONLY the card fields,
 * validates them to the same limits the generator is held to, and
 * merges the card into `metadata` on the server.
 *
 * Mounted under /api/admin behind requireJwt and the admin router's rate
 * limit (register-routes.ts).
 *
 * Authorization asks the database, AS THE CALLER, whether they may
 * administer this event -- can_admin_host_media('event', id), the same
 * question and the same fail-closed handling as host-media's organiser
 * routes (authorize-host.ts). Only once that answers `true` is the photo
 * read and written, on the service client, scoped to this event and id.
 *
 * It does not simply run the query as the user and let RLS decide, which
 * was the first version. On a deployment without the templates module,
 * host_media's public-read policy calls templates.can_read_host() and the
 * schema does not exist, so EVERY user-scoped SELECT on host_media fails
 * -- the policy is evaluated even for an admin whom the admin policy
 * would have allowed. That is a host-media bug; this route stays out of
 * its way rather than depending on it being fixed first.
 */
import type { Request, Response, Router } from 'express';
import { validateCardInput } from '../lib/card-copy.js';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface AdminMediaDeps {
  /**
   * Whether the caller may administer the event, asked as the caller.
   * `null` means there is no usable session.
   */
  canAdminEvent: (req: Request, eventId: string) => Promise<boolean | null>;
  /** Service-role client, used only after the caller is authorised. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceClient: any;
  logger: PlatformLogger;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

export function createAdminMediaRoutes(deps: AdminMediaDeps) {
  const { canAdminEvent, serviceClient: db, logger } = deps;

  async function putCard(req: Request, res: Response): Promise<void> {
    const eventId = req.params['eventId'];
    const mediaId = req.params['mediaId'];
    if (typeof eventId !== 'string' || !UUID_RE.test(eventId)) {
      sendError(res, 400, 'invalid_event_id', 'eventId must be a UUID');
      return;
    }
    if (typeof mediaId !== 'string' || !UUID_RE.test(mediaId)) {
      sendError(res, 400, 'invalid_media_id', 'mediaId must be a UUID');
      return;
    }

    // Validation reads only the five card fields out of the body.
    const parsed = validateCardInput((req.body as Record<string, unknown> | undefined)?.card);
    if (!parsed.ok) {
      sendError(res, 400, 'invalid_card', parsed.error);
      return;
    }

    // Fails closed: no session, an error, a throw, or anything but `true`
    // denies.
    let allowed: boolean | null;
    try {
      allowed = await canAdminEvent(req, eventId);
    } catch (err) {
      logger.error('card edit: authorisation check threw', {
        eventId, error: err instanceof Error ? err.message : String(err),
      });
      allowed = false;
    }
    if (allowed === null) {
      sendError(res, 401, 'unauthenticated', 'session required');
      return;
    }
    if (!allowed) {
      sendError(res, 403, 'forbidden', 'not authorised to edit media for this event');
      return;
    }

    // Scoped to THIS event: an id belonging to another event reads as not
    // found, so an admin of one event cannot reach another's photos by
    // pairing their own event id with someone else's media id.
    const { data: row, error: readErr } = await db
      .from('host_media')
      .select('id, metadata')
      .eq('id', mediaId)
      .eq('host_kind', 'event')
      .eq('host_id', eventId)
      .maybeSingle();
    if (readErr) {
      logger.error('card edit: read failed', { mediaId, error: readErr.message });
      sendError(res, 500, 'read_failed', 'could not load the photo');
      return;
    }
    if (!row) {
      sendError(res, 404, 'not_found', 'photo not found');
      return;
    }

    // Merge, never replace: everything else in metadata is kept as it is.
    const metadata = {
      ...((row.metadata ?? {}) as Record<string, unknown>),
      card: parsed.card,
    };
    const { data: updated, error: writeErr } = await db
      .from('host_media')
      .update({ metadata })
      .eq('id', mediaId)
      .eq('host_kind', 'event')
      .eq('host_id', eventId)
      .select('id, metadata')
      .maybeSingle();
    if (writeErr || !updated) {
      logger.warn('card edit: write failed', { mediaId, error: writeErr?.message });
      sendError(res, 500, 'write_failed', 'could not save the card');
      return;
    }

    res.status(200).json({ card: (updated.metadata as Record<string, unknown>).card });
  }

  return { putCard };
}

export function mountAdminMediaRoutes(router: Router, routes: ReturnType<typeof createAdminMediaRoutes>): void {
  router.put('/events/:eventId/media/:mediaId/card', routes.putCard);
}
