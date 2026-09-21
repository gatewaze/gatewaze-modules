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
 * limit (register-routes.ts). Authorization is real RLS: the update runs
 * on a client built from the caller's own token, so host_media's admin
 * policy -- can_admin_host_media -> can_admin_event -- decides, exactly
 * as for every other admin write in this module.
 */
import type { Request, Response, Router } from 'express';
import { validateCardInput } from '../lib/card-copy.js';

interface PlatformLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface AdminMediaDeps {
  /** Builds a Supabase client scoped to the calling user's JWT. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  userClient: (req: Request) => any | null;
  logger: PlatformLogger;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

export function createAdminMediaRoutes(deps: AdminMediaDeps) {
  const { userClient, logger } = deps;

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

    const db = userClient(req);
    if (!db) {
      sendError(res, 401, 'unauthenticated', 'session required');
      return;
    }

    // Scoped to this event's photos. A row the caller may not administer
    // is invisible under RLS, so it reads as not found rather than as a
    // refusal -- which also avoids saying whether the id exists.
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
      // An update RLS refuses returns no row rather than an error.
      logger.warn('card edit: write refused or failed', { mediaId, error: writeErr?.message });
      sendError(res, writeErr ? 500 : 403, writeErr ? 'write_failed' : 'forbidden',
        writeErr ? 'could not save the card' : 'not authorised to edit this photo');
      return;
    }

    res.status(200).json({ card: (updated.metadata as Record<string, unknown>).card });
  }

  return { putCard };
}

export function mountAdminMediaRoutes(router: Router, routes: ReturnType<typeof createAdminMediaRoutes>): void {
  router.put('/events/:eventId/media/:mediaId/card', routes.putCard);
}
