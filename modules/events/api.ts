/**
 * API routes for the events module.
 *
 * Provides endpoints for managing events, registrations, attendance, and CSV
 * import/export. Routes are registered at their original paths (not under
 * /api/m/events/) for backward compatibility.
 */

import type { Express, Request, Response } from 'express';
import type { ModuleContext } from '@gatewaze/shared';
import { createRequire } from 'module';
import { join } from 'path';
import { Readable } from 'stream';

let _supabase: any = null;

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

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Generate 6-character event ID: 3-4 random lowercase letters + remaining
 * digits, shuffled. Checks existing IDs to avoid collisions.
 */
async function generateEventId(supabase: any): Promise<string> {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';

  const { data: existingEvents } = await supabase
    .from('events')
    .select('event_id');
  const existingIds = new Set(existingEvents?.map((e: { event_id: string }) => e.event_id) || []);

  let id: string;
  do {
    id = '';
    const letterCount = 3 + Math.floor(Math.random() * 2); // 3 or 4 letters
    for (let i = 0; i < letterCount; i++) {
      id += letters[Math.floor(Math.random() * letters.length)];
    }
    const remainingChars = 6 - letterCount;
    for (let i = 0; i < remainingChars; i++) {
      id += numbers[Math.floor(Math.random() * numbers.length)];
    }
    // Shuffle the characters
    id = id.split('').sort(() => Math.random() - 0.5).join('');
  } while (existingIds.has(id));

  return id;
}

const VALID_CHECK_IN_METHODS = ['qr_scan', 'manual_entry', 'badge_scan', 'mobile_app', 'sponsor_booth'];

async function ensureRegistration(supabase: any, eventId: string, email: string) {
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

async function markAttendance(supabase: any, attendanceData: any) {
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
    const updates: any = { attendance_metadata: metadata };
    if (check_in_location !== undefined) updates.check_in_location = check_in_location;
    if (checked_in_by !== undefined) updates.checked_in_by = checked_in_by;
    if (badge_printed_on_site !== undefined) updates.badge_printed_on_site = badge_printed_on_site;
    if (sessions_attended.length > 0) updates.sessions_attended = sessions_attended;
    if (badge_printed_on_site === true) updates.badge_printed_at = new Date().toISOString();
    if (source !== undefined) updates.source = source;
    if (utm_source !== undefined) updates.utm_source = utm_source;
    if (utm_medium !== undefined) updates.utm_medium = utm_medium;
    if (utm_campaign !== undefined) updates.utm_campaign = utm_campaign;
    if (referrer !== undefined) updates.referrer = referrer;

    const { error } = await supabase.from('events_attendance').update(updates).eq('id', existing.id);
    if (error) throw new Error(`Failed to update attendance: ${error.message}`);

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
  const insertData: any = {
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
  if (source) insertData.source = source;
  else if (utm_source) insertData.source = utm_source;
  if (utm_source) insertData.utm_source = utm_source;
  if (utm_medium) insertData.utm_medium = utm_medium;
  if (utm_campaign) insertData.utm_campaign = utm_campaign;
  if (referrer) insertData.referrer = referrer;

  const { data: attendance, error } = await supabase
    .from('events_attendance')
    .insert(insertData)
    .select()
    .single();

  if (error) throw new Error(`Failed to create attendance: ${error.message}`);

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

function parseCsvBuffer(csvParse: any, buffer: Buffer): Promise<Record<string, string>[]> {
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
    fileFilter: (_req: any, file: any, cb: any) => {
      if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
        cb(null, true);
      } else {
        cb(new Error('Only CSV files are allowed'));
      }
    },
  });

  // ── Events ─────────────────────────────────────────────────────────────────

  // List events
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

  // Create event
  app.post('/api/events', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);

      const body = { ...req.body };
      if (!body.event_id) {
        body.event_id = await generateEventId(supabase);
      }

      const { data, error } = await supabase
        .from('events')
        .insert(body)
        .select()
        .single();

      if (error) throw error;
      res.status(201).json(data);
    } catch (err) {
      console.error('Error creating event:', err);
      res.status(500).json({ error: 'Failed to create event' });
    }
  });

  // Get single event
  app.get('/api/events/:id', async (req: Request, res: Response) => {
    try {
      const supabase = initSupabase(projectRoot);
      const { data, error } = await supabase
        .from('events')
        .select('*')
        .eq('id', req.params.id)
        .single();

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
      res.status(500).json({ error: 'Failed to delete event' });
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
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
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
      const results: any[] = [];
      for (const attendee of attendees) {
        try {
          const result = await markAttendance(supabase, attendee);
          results.push({ email: attendee.email, ...result });
        } catch (error: any) {
          results.push({ email: attendee.email, success: false, error: error.message });
        }
      }

      const succeeded = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      res.json({ success: true, total: attendees.length, succeeded, failed, results });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
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
              error: `Batch insert failed: ${error.message}`,
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
