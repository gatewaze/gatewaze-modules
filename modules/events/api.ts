/**
 * API routes for the events module.
 *
 * Provides endpoints for managing events, registrations, attendance, and CSV
 * import/export. Routes are registered at their original paths (not under
 * /api/m/events/) for backward compatibility.
 */

import type { Express, Request, Response, NextFunction } from 'express';
import type { ModuleContext } from '@gatewaze/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createAdminListingRoute,
  createAdminDistinctRoute,
  buildHandlerContext,
  listingCache,
  type HandlerContext,
} from '@gatewaze/shared/listing';
import { createRequire } from 'module';
import { join } from 'path';
import { Readable } from 'stream';
import { eventsListingSchema } from './listing-schema';

let _supabase: SupabaseClient | null = null;

function initSupabase(projectRoot: string) {
  if (_supabase) return _supabase;

  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

  const require = createRequire(join(projectRoot, 'packages', 'api', 'package.json'));
  const { createClient } = require('@supabase/supabase-js');
  _supabase = createClient(url, key);
  return _supabase;
}

/**
 * Extract a human-readable message from an error thrown by supabase-js /
 * PostgREST. Those errors are plain objects ({ message, details, hint, code }),
 * NOT Error instances — so `String(err)` yields the useless "[object Object]"
 * that masked a foreign-key violation behind the events bulk-delete route.
 */
function pgErrorMessage(err: unknown): string {
  if (!err) return 'unknown error';
  if (err instanceof Error) return err.message;
  if (typeof err === 'object') {
    const e = err as { message?: string; details?: string; hint?: string; code?: string };
    const parts = [
      e.message,
      e.details,
      e.hint ? `hint: ${e.hint}` : undefined,
      e.code ? `(${e.code})` : undefined,
    ].filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  return String(err);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Generate a candidate 6-character event ID: 3-4 random lowercase
 * letters + remaining digits, shuffled. Pure function — caller must
 * verify uniqueness against the DB.
 *
 * Closes spec PR-H-15. The previous implementation scanned the entire
 * events table on every event creation to build a set of existing IDs;
 * that approach is O(n) in event count and unsafe under concurrent
 * inserts. The events.event_id UNIQUE constraint is the real source
 * of truth; collisions are rare (36^6 ≈ 2 billion) and handled with
 * a small retry loop at the insert call site.
 */
function generateCandidateEventId(): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  let id = '';
  const letterCount = 3 + Math.floor(Math.random() * 2); // 3 or 4 letters
  for (let i = 0; i < letterCount; i++) {
    id += letters[Math.floor(Math.random() * letters.length)];
  }
  const remainingChars = 6 - letterCount;
  for (let i = 0; i < remainingChars; i++) {
    id += numbers[Math.floor(Math.random() * numbers.length)];
  }
  return id.split('').sort(() => Math.random() - 0.5).join('');
}

const ID_GENERATION_MAX_RETRIES = 8;

/**
 * Generate a candidate event_id; the caller should attempt the insert
 * and retry on a 23505 (unique violation) error. This helper just
 * issues new candidates.
 */
function generateEventId(): string {
  return generateCandidateEventId();
}

/**
 * Helper: insert an event with retry-on-collision. Returns the
 * inserted row. Throws after MAX_RETRIES (extremely rare).
 */
async function insertEventWithRetry(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < ID_GENERATION_MAX_RETRIES; attempt++) {
    if (!body.event_id) {
      body.event_id = generateEventId();
    }
    const { data, error } = await supabase
      .from('events')
      .insert(body)
      .select()
      .single();
    if (!error) return data;
    // Postgres unique-violation = 23505. PostgREST surfaces it via
    // the `code` field on the error object.
    if (error.code === '23505' && /event_id/.test(error.message ?? '')) {
      // Collision — clear the candidate so the next loop generates a fresh one.
      body.event_id = null;
      lastError = error;
      continue;
    }
    throw error;
  }
  throw lastError ?? new Error('event_id collision retries exhausted');
}

const VALID_CHECK_IN_METHODS = ['qr_scan', 'manual_entry', 'badge_scan', 'mobile_app', 'sponsor_booth'];

async function ensureRegistration(supabase: SupabaseClient, eventId: string, email: string) {
  const { data: customer, error: customerError } = await supabase
    .from('people')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (customerError) throw new Error(`Error finding customer: ${customerError.message}`);
  if (!customer) throw new Error(`Customer not found for email: ${email}`);

  const { data: member, error: memberError } = await supabase
    .from('people_profiles')
    .select('id')
    .eq('person_id', customer.id)
    .maybeSingle();

  if (memberError) throw new Error(`Error finding member profile: ${memberError.message}`);
  if (!member) throw new Error(`Member profile not found for customer: ${customer.id}`);

  const { data: registration, error: registrationError } = await supabase
    .from('events_registrations')
    .select('id')
    .eq('event_id', eventId)
    .eq('people_profile_id', member.id)
    .maybeSingle();

  if (registrationError) throw new Error(`Error finding registration: ${registrationError.message}`);
  if (!registration) throw new Error(`No registration found for email ${email} at event ${eventId}`);

  return {
    customer_id: customer.id,
    people_profile_id: member.id,
    registration_id: registration.id,
  };
}

interface AttendanceData {
  event_id: string;
  email: string;
  check_in_method?: string;
  check_in_location?: string;
  checked_in_by?: string;
  badge_printed_on_site?: boolean;
  sessions_attended?: string[];
  metadata?: Record<string, unknown>;
  source?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  referrer?: string;
}

async function markAttendance(supabase: SupabaseClient, attendanceData: AttendanceData) {
  const {
    event_id,
    email,
    check_in_method = 'manual_entry',
    check_in_location,
    checked_in_by,
    badge_printed_on_site = false,
    sessions_attended = [],
    metadata = {},
    source,
    utm_source,
    utm_medium,
    utm_campaign,
    referrer,
  } = attendanceData;

  const { people_profile_id, registration_id } = await ensureRegistration(supabase, event_id, email);

  // Check existing attendance
  const { data: existing } = await supabase
    .from('events_attendance')
    .select('id, checked_in_at')
    .eq('event_id', event_id)
    .eq('people_profile_id', people_profile_id)
    .maybeSingle();

  if (existing) {
    const updates: Record<string, unknown> = { attendance_metadata: metadata };
    if (check_in_location !== undefined) updates.check_in_location = check_in_location;
    if (checked_in_by !== undefined) updates.checked_in_by = checked_in_by;
    if (badge_printed_on_site !== undefined) updates.badge_printed_on_site = badge_printed_on_site;
    if (sessions_attended.length > 0) updates.sessions_attended = sessions_attended;
    if (badge_printed_on_site === true) updates.badge_printed_at = new Date().toISOString();
    if (source !== undefined) updates.registration_source = source;
    if (utm_source !== undefined) updates.utm_source = utm_source;
    if (utm_medium !== undefined) updates.utm_medium = utm_medium;
    if (utm_campaign !== undefined) updates.utm_campaign = utm_campaign;
    if (referrer !== undefined) updates.referrer = referrer;

    const { error } = await supabase.from('events_attendance').update(updates).eq('id', existing.id);
    if (error) throw new Error(`Failed to update attendance: ${(error instanceof Error ? error.message : String(error))}`);

    return {
      success: true,
      attendance_id: existing.id,
      people_profile_id,
      registration_id,
      already_checked_in: true,
      checked_in_at: existing.checked_in_at,
    };
  }

  // Create new record
  const insertData: Record<string, unknown> = {
    event_id,
    people_profile_id,
    event_registration_id: registration_id,
    check_in_method,
    check_in_location,
    checked_in_by,
    badge_printed_on_site,
    sessions_attended: sessions_attended.length > 0 ? sessions_attended : null,
    attendance_metadata: metadata,
    checked_in_at: new Date().toISOString(),
  };

  if (badge_printed_on_site) insertData.badge_printed_at = new Date().toISOString();
  if (source) insertData.registration_source = source;
  else if (utm_source) insertData.registration_source = utm_source;
  if (utm_source) insertData.utm_source = utm_source;
  if (utm_medium) insertData.utm_medium = utm_medium;
  if (utm_campaign) insertData.utm_campaign = utm_campaign;
  if (referrer) insertData.referrer = referrer;

  const { data: attendance, error } = await supabase
    .from('events_attendance')
    .insert(insertData)
    .select()
    .single();

  if (error) throw new Error(`Failed to create attendance: ${(error instanceof Error ? error.message : String(error))}`);

  return {
    success: true,
    attendance_id: attendance.id,
    people_profile_id,
    registration_id,
    already_checked_in: false,
    checked_in_at: attendance.checked_in_at,
  };
}

// ── CSV Helpers ────────────────────────────────────────────────────────────────

function parseCsvBuffer(csvParse: (opts: Record<string, unknown>) => NodeJS.ReadWriteStream, buffer: Buffer): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    const records: Record<string, string>[] = [];
    const stream = Readable.from(buffer);

    stream
      .pipe(
        csvParse({
          columns: true,
          skip_empty_lines: true,
          trim: true,
          bom: true,
        })
      )
      .on('data', (record: Record<string, string>) => records.push(record))
      .on('end', () => resolve(records))
      .on('error', (err: Error) => reject(err));
  });
}

function normalizeEventRecord(record: Record<string, string>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  const fieldMap: Record<string, string> = {
    title: 'event_title',
    name: 'event_title',
    event_name: 'event_title',
    event_title: 'event_title',
    description: 'event_description',
    event_description: 'event_description',
    start_date: 'event_start',
    start: 'event_start',
    event_start: 'event_start',
    end_date: 'event_end',
    end: 'event_end',
    event_end: 'event_end',
    location: 'event_location',
    location_name: 'event_location',
    event_location: 'event_location',
    venue: 'event_location',
    status: 'status',
    url: 'url',
    image_url: 'event_logo',
    event_logo: 'event_logo',
    event_id: 'event_id',
  };

  for (const [csvKey, value] of Object.entries(record)) {
    const dbKey = fieldMap[csvKey.toLowerCase().trim()] ?? csvKey.toLowerCase().trim();
    if (value !== '') {
      normalized[dbKey] = value;
    }
  }

  if (!normalized.event_title) {
    throw new Error('Missing required field: title');
  }

  return normalized;
}

// ── Admin Listing (shared listing primitive) ───────────────────────────────

const eventsAdminListingHandler = createAdminListingRoute({
  schema: eventsListingSchema,
  path: '/api/admin/events/list',
});

const eventsAdminDistinctHandler = createAdminDistinctRoute({
  schema: eventsListingSchema,
  path: '/api/admin/events/distinct/:column',
});

function buildAdminCtx(req: Request): HandlerContext {
  return buildHandlerContext({
    consumer: 'admin',
    ip: req.ip || '',
    headers: req.headers as Record<string, string | string[] | undefined>,
    requestId:
      (req.headers['x-request-id'] as string | undefined) ||
      `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    // Admin role is enforced upstream by the platform admin guard.
  });
}

function registerEventsAdminListing(app: Express, projectRoot: string) {
  app.get('/api/admin/events/list', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { status, body } = await eventsAdminListingHandler.handle(
        { query: req.query as Record<string, unknown>, ctx: buildAdminCtx(req) },
        supabase
      );
      res.status(status).json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { code: 'LISTING_INTERNAL_ERROR', message } });
    }
  });

  app.get('/api/admin/events/distinct/:column', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { status, body } = await eventsAdminDistinctHandler.handle(
        { column: req.params.column, query: req.query as Record<string, unknown>, ctx: buildAdminCtx(req) },
        supabase
      );
      res.status(status).json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { code: 'LISTING_INTERNAL_ERROR', message } });
    }
  });

  // Events eligible for outbound Luma sync. This is the server-side
  // ownership gate for the luma-event-sync agent: only events on a calendar
  // with luma_sync_enabled = true are returned, so the agent physically
  // cannot see (or edit) events we merely scraped. Each row carries its
  // target luma_calendar_id. A row is included only when it has a Luma
  // counterpart and has changed since its last successful push.
  app.get('/api/admin/events/luma-syncable', async (_req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data, error } = await supabase
        .from('calendars')
        .select(
          'luma_calendar_id, calendars_events(events(id, event_id, event_title, event_description, event_start, event_end, event_timezone, event_location, venue_address, event_featured_image, luma_event_id, luma_sync_status, luma_synced_at, updated_at))',
        )
        .eq('luma_sync_enabled', true);
      if (error) throw error;

      type EvRow = {
        luma_event_id: string | null;
        luma_synced_at: string | null;
        updated_at: string | null;
      } & Record<string, unknown>;
      const out: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      for (const cal of (data ?? []) as Array<Record<string, unknown>>) {
        const links = (cal.calendars_events ?? []) as Array<{ events: EvRow | null }>;
        for (const link of links) {
          const ev = link.events;
          if (!ev || !ev.luma_event_id) continue;
          const needsSync =
            !ev.luma_synced_at ||
            (ev.updated_at != null && new Date(ev.updated_at) > new Date(ev.luma_synced_at));
          if (!needsSync) continue;
          if (seen.has(ev.id as string)) continue;
          seen.add(ev.id as string);
          out.push({ ...ev, luma_calendar_id: cal.luma_calendar_id });
        }
      }
      res.json({ events: out });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: { code: 'LUMA_SYNCABLE_INTERNAL_ERROR', message } });
    }
  });

  // Bulk-delete by ids (admin-only). Pass-through to EventService-style
  // delete; the EventsPage wires this to the selection state.
  app.post('/api/admin/events/bulk-delete', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const body = req.body as { ids?: string[]; matchingFilter?: Record<string, unknown> };
      let ids: string[] = [];

      if (Array.isArray(body.ids) && body.ids.length > 0) {
        ids = body.ids;
      } else if (body.matchingFilter && typeof body.matchingFilter === 'object') {
        // Resolve "select all matching filter" to a concrete id list by
        // running the same listing query once with a high page size.
        // For v1 we cap at 5000; beyond that the operator should narrow
        // their filter or use the legacy bulk-edit page.
        const listResult = await eventsAdminListingHandler.handle(
          { query: { ...body.matchingFilter, page: 0, pageSize: 5000 } as never, ctx: buildAdminCtx(req) },
          supabase
        );
        if (listResult.status !== 200 || !('rows' in listResult.body)) {
          res.status(listResult.status).json(listResult.body);
          return;
        }
        ids = (listResult.body.rows as Array<{ id: string }>).map((r) => r.id).filter(Boolean);
        if (ids.length >= 5000) {
          res.status(409).json({
            error: {
              code: 'BULK_LIMIT_EXCEEDED',
              message: 'select-all-matching capped at 5000 rows; please narrow the filter and retry',
            },
          });
          return;
        }
      } else {
        res.status(400).json({ error: { code: 'INVALID_BULK_REQUEST', message: 'either ids[] or matchingFilter required' } });
        return;
      }

      if (ids.length === 0) {
        res.json({ success: true, deleted: 0 });
        return;
      }

      const { error, count } = await supabase
        .from('events')
        .delete({ count: 'exact' })
        .in('id', ids);

      if (error) {
        res.status(500).json({ error: { code: 'DELETE_FAILED', message: pgErrorMessage(error) } });
        return;
      }
      // Bust admin listing cache for events so the next list call reflects
      // the deletion immediately. Per spec §14.
      listingCache.emit({ module: 'events', table: 'events', reason: 'bulk-delete' });
      res.json({ success: true, deleted: count ?? ids.length });
    } catch (err) {
      res.status(500).json({ error: { code: 'LISTING_INTERNAL_ERROR', message: pgErrorMessage(err) } });
    }
  });

  // Change an event's publish_state from the event detail page. Runs the central
  // state-machine RPC (events_publish_state_set → content_publish_state_set),
  // which is GRANTed to service_role only — hence this server-side route rather
  // than a browser rpc() call. The RPC validates the transition and writes an
  // audit row. Mirrors the inbox's set_state action for a single event.
  app.post('/api/admin/events/:id/publish-state', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { to, reason } = (req.body ?? {}) as { to?: string; reason?: string };
      const VALID_STATES = [
        'draft', 'pending_review', 'auto_suppressed', 'rejected', 'published', 'unpublished',
      ];
      if (!to || !VALID_STATES.includes(to)) {
        res.status(400).json({ error: { code: 'INVALID_STATE', message: `\"to\" must be one of: ${VALID_STATES.join(', ')}` } });
        return;
      }

      // Resolve the acting admin from the bearer token when present (audit trail).
      let actor = 'admin:ui';
      const authHeader = req.headers.authorization;
      if (authHeader) {
        const token = authHeader.replace(/^Bearer\s+/i, '');
        try {
          const { data, error: authErr } = await supabase.auth.getUser(token);
          if (!authErr && data?.user?.id) actor = `admin:${data.user.id}`;
        } catch {
          // fall through — actor stays 'admin:ui'
        }
      }

      const { error } = await supabase.rpc('events_publish_state_set', {
        p_id: req.params.id,
        p_to: to,
        p_actor: actor,
        p_reason: reason ?? 'admin_ui:event_detail',
      });

      if (error) {
        // 23514 = invalid state transition (raised by content_publish_state_set),
        // P0002 = event row not found. Surface both as client errors.
        const code = (error as { code?: string }).code;
        if (code === '23514') {
          res.status(409).json({ error: { code: 'INVALID_STATE_TRANSITION', message: pgErrorMessage(error) } });
          return;
        }
        if (code === 'P0002') {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: pgErrorMessage(error) } });
          return;
        }
        res.status(500).json({ error: { code: 'PUBLISH_STATE_FAILED', message: pgErrorMessage(error) } });
        return;
      }

      // Read back the persisted state so the client can trust the result.
      const { data: row } = await supabase
        .from('events')
        .select('publish_state')
        .eq('id', req.params.id)
        .single();

      listingCache.emit({ module: 'events', table: 'events', reason: 'publish-state' });
      res.json({ success: true, publish_state: row?.publish_state ?? to });
    } catch (err) {
      res.status(500).json({ error: { code: 'PUBLISH_STATE_FAILED', message: pgErrorMessage(err) } });
    }
  });
}

// ── Route Registration ─────────────────────────────────────────────────────────

export function registerRoutes(app: Express, context?: ModuleContext) {
  const projectRoot = context?.projectRoot || process.cwd();

  // Lazy-load multer and csv-parse/csv-stringify via createRequire
  const apiRequire = createRequire(join(projectRoot, 'packages', 'api', 'package.json'));
  const multer = apiRequire('multer');
  const { parse: csvParse } = apiRequire('csv-parse');
  const { stringify: csvStringify } = apiRequire('csv-stringify');

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (
      _req: Request,
      file: Express.Multer.File,
      cb: (error: Error | null, accept?: boolean) => void,
    ) => {
      if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
        cb(null, true);
      } else {
        cb(new Error('Only CSV files are allowed'));
      }
    },
  });

  // ── Admin listing (per spec-platform-listing-pattern.md) ──────────────────

  // The shared listing primitive: paginated, validated, indexed admin
  // table feed. Replaces the ad-hoc /api/events list call from the
  // admin EventsPage. The legacy /api/events route below is kept
  // running for any callers that still depend on it.
  registerEventsAdminListing(app, projectRoot);

  // ── Events ─────────────────────────────────────────────────────────────────

  // List events (legacy — to be removed once all callers migrate)
  app.get('/api/events', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
      const search = req.query.search as string;

      let query = supabase
        .from('events')
        .select('*', { count: 'exact' })
        .order('event_start', { ascending: false })
        .range((page - 1) * limit, page * limit - 1);

      if (search) query = query.ilike('event_title', `%${search}%`);

      const { data, error, count } = await query;
      if (error) throw error;

      res.json({ data, total: count, page, limit });
    } catch (err) {
      console.error('Error fetching events:', err);
      res.status(500).json({ error: 'Failed to fetch events' });
    }
  });

  // Create event — uses insert-with-retry on event_id UNIQUE collision.
  // No table scan; relies on the events.event_id UNIQUE constraint.
  app.post('/api/events', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const body = { ...req.body };
      const data = await insertEventWithRetry(supabase, body);
      res.status(201).json(data);
    } catch (err) {
      console.error('Error creating event:', err);
      res.status(500).json({ error: 'Failed to create event' });
    }
  });

  // Get single event by UUID OR by short event_id (e.g. "k593lq").
  // The portal uses the short event_id in URLs, the admin uses UUID.
  // Previously the route only tried `id = $param` which threw
  // PG 22P02 "invalid input syntax for type uuid" on every short-id
  // request — surfacing as a 500 + portal page 404.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  app.get('/api/events/:id', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const ident = req.params.id;
      // Pick the column based on shape — never send a non-UUID into
      // the `id` filter, PG rejects it before RLS even runs.
      const column = UUID_RE.test(ident) ? 'id' : 'event_id';
      const { data, error } = await supabase
        .from('events')
        .select('*')
        .eq(column, ident)
        .maybeSingle();

      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Event not found' });

      res.json(data);
    } catch (err) {
      console.error('Error fetching event:', err);
      res.status(500).json({ error: 'Failed to fetch event' });
    }
  });

  // Update event
  app.patch('/api/events/:id', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data, error } = await supabase
        .from('events')
        .update(req.body)
        .eq('id', req.params.id)
        .select()
        .single();

      if (error) throw error;
      res.json(data);
    } catch (err) {
      console.error('Error updating event:', err);
      res.status(500).json({ error: 'Failed to update event' });
    }
  });

  // Delete event
  app.delete('/api/events/:id', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { error } = await supabase
        .from('events')
        .delete()
        .eq('id', req.params.id);

      if (error) throw error;
      res.status(204).send();
    } catch (err) {
      console.error('Error deleting event:', err);
      res.status(500).json({ error: `Failed to delete event: ${pgErrorMessage(err)}` });
    }
  });

  // ── Registrations ──────────────────────────────────────────────────────────

  // List registrations
  app.get('/api/registrations', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
      const eventId = req.query.event_id as string;
      const status = req.query.status as string;

      let query = supabase
        .from('events_registrations')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range((page - 1) * limit, page * limit - 1);

      if (eventId) query = query.eq('event_id', eventId);
      if (status) query = query.eq('status', status);

      const { data, error, count } = await query;
      if (error) throw error;

      res.json({ data, total: count, page, limit });
    } catch (err) {
      console.error('Error fetching registrations:', err);
      res.status(500).json({ error: 'Failed to fetch registrations' });
    }
  });

  // Create registration
  app.post('/api/registrations', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data, error } = await supabase
        .from('events_registrations')
        .insert(req.body)
        .select()
        .single();

      if (error) throw error;
      res.status(201).json(data);
    } catch (err) {
      console.error('Error creating registration:', err);
      res.status(500).json({ error: 'Failed to create registration' });
    }
  });

  // Bulk-create registrations (admin CSV import → BulkRegistrationService).
  // Per row: find or create the person (via the people-signup edge function),
  // ensure a people profile, insert the events_registrations row (idempotent
  // per person+event, honouring update_existing), and opt the person into the
  // global "Event Updates" list. Returns the { total, successful, failed,
  // errors:[{index,email,error}] } shape the client expects.
  app.post('/api/registrations/bulk', async (req: Request, res: Response) => {
    try {
      const { event_id, update_existing = false, registrations } = req.body ?? {};

      if (!event_id) {
        return res.status(400).json({ error: 'event_id is required' });
      }
      if (!Array.isArray(registrations) || registrations.length === 0) {
        return res.status(400).json({ error: 'registrations array required' });
      }

      const supabase = initSupabase(projectRoot);

      // events_registrations.event_id references events.id (UUID). Accept a UUID
      // as-is, otherwise resolve the short public event_id (varchar) to the UUID.
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let eventUuid: string | null = null;
      if (uuidRe.test(String(event_id))) {
        eventUuid = String(event_id);
      } else {
        const { data: ev } = await supabase.from('events').select('id').eq('event_id', event_id).maybeSingle();
        eventUuid = ev?.id ?? null;
      }
      if (!eventUuid) {
        return res.status(404).json({ error: `Event not found: ${event_id}` });
      }

      // Resolve the global "Event Updates" list once (subscription is best-effort).
      const { data: eventUpdatesList } = await supabase
        .from('lists').select('id').eq('slug', 'event-updates').maybeSingle();

      const VALID_TYPES = ['free', 'paid', 'comp', 'sponsor', 'speaker', 'staff', 'vip'];
      const errors: Array<{ index: number; email: string; error: string }> = [];
      let successful = 0;

      for (let i = 0; i < registrations.length; i++) {
        const reg = registrations[i] ?? {};
        const email = String(reg.email || '').trim().toLowerCase();
        try {
          if (!email) throw new Error('Missing email');

          // Find or create the person.
          let { data: person } = await supabase
            .from('people').select('id').ilike('email', email).maybeSingle();

          if (!person) {
            const { error: signupError } = await supabase.functions.invoke('people-signup', {
              body: {
                email,
                source: reg.source || 'admin_bulk_registration',
                user_metadata: {
                  first_name: reg.first_name || '',
                  last_name: reg.last_name || '',
                  company: reg.company || '',
                  job_title: reg.job_title || '',
                  linkedin_url: reg.linkedin_url || '',
                },
              },
            });
            if (signupError) throw new Error(`Failed to create person: ${signupError.message ?? signupError}`);

            const { data: created } = await supabase
              .from('people').select('id').ilike('email', email).maybeSingle();
            person = created;
          } else if (update_existing) {
            // Enrich attributes for existing people when requested (best-effort).
            const { error: updErr } = await supabase.rpc('people_update_attributes', {
              p_person_id: person.id,
              p_first_name: reg.first_name || '',
              p_last_name: reg.last_name || '',
              p_company: reg.company || '',
              p_job_title: reg.job_title || '',
              ...(reg.linkedin_url ? { p_linkedin_url: reg.linkedin_url } : {}),
            });
            if (updErr) console.error(`people_update_attributes failed for ${email}:`, updErr.message);
          }

          if (!person) throw new Error('Person could not be created');

          // Ensure a people profile.
          const { data: peopleProfileId, error: profileError } = await supabase
            .rpc('people_get_or_create_profile', { p_person_id: person.id });
          if (profileError) throw new Error(`Failed to create profile: ${profileError.message}`);

          // Idempotent per person + event.
          const { data: existingReg } = await supabase
            .from('events_registrations')
            .select('id')
            .eq('event_id', eventUuid)
            .eq('person_id', person.id)
            .maybeSingle();

          const regType = VALID_TYPES.includes(reg.registration_type) ? reg.registration_type : 'comp';

          if (existingReg) {
            if (update_existing) {
              const updates: Record<string, unknown> = {};
              if (reg.ticket_type) updates.ticket_type = reg.ticket_type;
              if (reg.registration_type && VALID_TYPES.includes(reg.registration_type)) {
                updates.registration_type = reg.registration_type;
              }
              if (reg.registered_at) updates.registered_at = reg.registered_at;
              if (Object.keys(updates).length > 0) {
                await supabase.from('events_registrations').update(updates).eq('id', existingReg.id);
              }
            }
            // Already registered → idempotent success.
          } else {
            const { error: insertError } = await supabase
              .from('events_registrations')
              .insert({
                event_id: eventUuid,
                person_id: person.id,
                people_profile_id: peopleProfileId,
                status: 'confirmed',
                registration_type: regType,
                registration_source: reg.source || 'admin_bulk_registration',
                ticket_type: reg.ticket_type || null,
                registered_at: reg.registered_at || new Date().toISOString(),
              });
            if (insertError) throw new Error(`Failed to create registration: ${insertError.message}`);
          }

          // Opt the registrant into the global "Event Updates" list (best-effort).
          if (eventUpdatesList?.id) {
            const now = new Date().toISOString();
            const { error: subError } = await supabase
              .from('list_subscriptions')
              .upsert({
                list_id: eventUpdatesList.id,
                person_id: person.id,
                email,
                subscribed: true,
                subscribed_at: now,
                unsubscribed_at: null,
                source: reg.source || 'admin_bulk_registration',
              }, { onConflict: 'list_id,email' });
            if (subError) console.error(`Failed to subscribe ${email} to event-updates:`, subError.message);
          }

          successful++;
        } catch (err) {
          errors.push({ index: i, email, error: err instanceof Error ? err.message : String(err) });
        }
      }

      res.json({
        total: registrations.length,
        successful,
        failed: errors.length,
        errors,
      });
    } catch (err) {
      console.error('Error in bulk registration:', err);
      res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) || 'Failed to process bulk registration' });
    }
  });

  // Get single registration
  app.get('/api/registrations/:id', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data, error } = await supabase
        .from('events_registrations')
        .select('*')
        .eq('id', req.params.id)
        .single();

      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Registration not found' });

      res.json(data);
    } catch (err) {
      console.error('Error fetching registration:', err);
      res.status(500).json({ error: 'Failed to fetch registration' });
    }
  });

  // Update registration
  app.patch('/api/registrations/:id', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data, error } = await supabase
        .from('events_registrations')
        .update(req.body)
        .eq('id', req.params.id)
        .select()
        .single();

      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Registration not found' });

      res.json(data);
    } catch (err) {
      console.error('Error updating registration:', err);
      res.status(500).json({ error: 'Failed to update registration' });
    }
  });

  // Delete registration
  app.delete('/api/registrations/:id', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { error } = await supabase
        .from('events_registrations')
        .delete()
        .eq('id', req.params.id);

      if (error) throw error;
      res.status(204).send();
    } catch (err) {
      console.error('Error deleting registration:', err);
      res.status(500).json({ error: 'Failed to delete registration' });
    }
  });

  // ── Attendance ─────────────────────────────────────────────────────────────

  // Mark attendance
  app.post('/api/attendance', async (req: Request, res: Response) => {
    try {
      const {
        event_id,
        email,
        check_in_method = 'manual_entry',
      } = req.body;

      if (!event_id || !email) {
        return res.status(400).json({ success: false, error: 'event_id and email are required' });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ success: false, error: 'Invalid email format' });
      }

      if (check_in_method && !VALID_CHECK_IN_METHODS.includes(check_in_method)) {
        return res.status(400).json({ success: false, error: `Invalid check_in_method. Must be one of: ${VALID_CHECK_IN_METHODS.join(', ')}` });
      }

      const supabase = initSupabase(projectRoot);

      // Async mode
      if (req.body.async === true) {
        res.json({ success: true, message: 'Attendance check-in queued for processing', email, event_id });
        markAttendance(supabase, req.body).catch(err => console.error('Async attendance failed:', err.message));
        return;
      }

      const result = await markAttendance(supabase, req.body);
      res.json(result);
    } catch (error) {
      res.status(400).json({ success: false, error: (error instanceof Error ? error.message : String(error)) });
    }
  });

  // Bulk attendance
  app.post('/api/attendance/bulk', async (req: Request, res: Response) => {
    try {
      const { attendees } = req.body;

      if (!Array.isArray(attendees) || attendees.length === 0) {
        return res.status(400).json({ success: false, error: 'attendees array required' });
      }

      const supabase = initSupabase(projectRoot);
      interface BatchAttendanceResult {
        email: string;
        success?: boolean;
        attendance_id?: string;
        people_profile_id?: string;
        registration_id?: string;
        already_checked_in?: boolean;
        checked_in_at?: string | null;
        error?: string;
      }
      const results: BatchAttendanceResult[] = [];
      for (const attendee of attendees) {
        try {
          const result = await markAttendance(supabase, attendee);
          results.push({ email: attendee.email, ...result });
        } catch (error) {
          results.push({ email: attendee.email, success: false, error: (error instanceof Error ? error.message : String(error)) });
        }
      }

      const succeeded = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      res.json({ success: true, total: attendees.length, succeeded, failed, results });
    } catch (error) {
      res.status(500).json({ success: false, error: (error instanceof Error ? error.message : String(error)) });
    }
  });

  // ── CSV Import/Export ──────────────────────────────────────────────────────

  // Import events from CSV
  app.post('/api/csv/import/events', upload.single('file'), async (req: Request, res: Response) => {
    try {
      if (!(req as any).file) {
        return res.status(400).json({ error: 'No CSV file provided' });
      }

      const records = await parseCsvBuffer(csvParse, (req as any).file.buffer);

      if (records.length === 0) {
        return res.status(400).json({ error: 'CSV file is empty' });
      }

      const supabase = initSupabase(projectRoot);
      const batchSize = 100;
      let inserted = 0;
      const errors: Array<{ row: number; error: string }> = [];

      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize).map((record, idx) => {
          try {
            return normalizeEventRecord(record);
          } catch (err) {
            errors.push({
              row: i + idx + 2,
              error: err instanceof Error ? err.message : 'Invalid record',
            });
            return null;
          }
        }).filter(Boolean);

        if (batch.length > 0) {
          const { error, count } = await supabase
            .from('events')
            .insert(batch)
            .select('id');

          if (error) {
            errors.push({
              row: i + 2,
              error: `Batch insert failed: ${(error instanceof Error ? error.message : String(error))}`,
            });
          } else {
            inserted += count ?? batch.length;
          }
        }
      }

      res.json({
        imported: inserted,
        total: records.length,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (err) {
      console.error('Error importing events CSV:', err);
      res.status(500).json({ error: 'Failed to import events' });
    }
  });

  // Export events to CSV
  app.get('/api/csv/export/events', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const status = req.query.status as string;

      let query = supabase
        .from('events')
        .select('*')
        .order('event_start', { ascending: false });

      if (status) query = query.eq('status', status);

      const { data, error } = await query;
      if (error) throw error;

      if (!data || data.length === 0) {
        return res.status(404).json({ error: 'No events found' });
      }

      const columns = Object.keys(data[0]);

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="events.csv"');

      const stringifier = csvStringify({ header: true, columns });
      stringifier.pipe(res);

      for (const row of data) {
        stringifier.write(row);
      }

      stringifier.end();
    } catch (err) {
      console.error('Error exporting events CSV:', err);
      res.status(500).json({ error: 'Failed to export events' });
    }
  });
}
