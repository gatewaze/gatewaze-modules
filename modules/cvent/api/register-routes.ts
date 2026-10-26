// @ts-nocheck — depends on express + supabase-js; resolved at module-host install time.
//
// Admin routes for the Cvent module, mounted under /api/modules/cvent/*.
// The platform does not auth-gate module routes, so every route here checks
// the caller is an admin with their own bearer token (is_admin RPC as the
// user) before anything else.
//
//   GET  /events/:eventId/settings          settings + sync counts + configured flag
//   PUT  /events/:eventId/settings          save the four Cvent fields on the event
//   GET  /events/:eventId/admission-items   admission items from Cvent for the dropdown
//   GET  /events/:eventId/registrants?q=    registrants matching q (for the test picker)
//   POST /events/:eventId/sync-now          one bounded sync batch, right now
//   POST /registrations/:registrationId/sync  push one registration (ignores the live-sync toggle)

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { createCventClient } from '../lib/cvent-api.js';
import { loadModuleConfig, parseCredentials, parseSyncSettings } from '../lib/config.js';
import {
  badgeFields,
  eventSyncStatus,
  isEventConfigured,
  loadCventEvent,
  syncEvent,
  syncOneRegistration,
  ACTIVE_STATUSES,
} from '../lib/sync.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A manual "sync now" from the admin runs inside the request; keep it short
// and let the worker cron finish the rest.
const SYNC_NOW_BUDGET_MS = 20_000;

export async function registerRoutes(app, _ctx) {
  const url = process.env.SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
  if (!url || !serviceKey) {
    console.warn('[cvent] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — routes disabled');
    return;
  }

  const service = createClient(url, serviceKey, { auth: { persistSession: false } });
  const router = Router();

  // Verify the caller is an active admin using their own bearer token.
  async function requireAdmin(req, res) {
    const authHeader = req.headers?.authorization ?? '';
    if (!authHeader || !anonKey) {
      res.status(401).json({ error: 'unauthenticated' });
      return false;
    }
    try {
      const asUser = createClient(url, anonKey, {
        auth: { persistSession: false },
        global: { headers: { Authorization: authHeader } },
      });
      const { data, error } = await asUser.rpc('is_admin');
      if (error || data !== true) {
        res.status(403).json({ error: 'admin_required' });
        return false;
      }
      return true;
    } catch {
      res.status(403).json({ error: 'admin_required' });
      return false;
    }
  }

  function uuidParam(req, res, name) {
    const v = req.params?.[name];
    if (typeof v !== 'string' || !UUID_RE.test(v)) {
      res.status(400).json({ error: `${name} must be a uuid` });
      return null;
    }
    return v.toLowerCase();
  }

  async function cventClientOrNull(res) {
    const creds = parseCredentials(await loadModuleConfig(service));
    if (!creds) {
      res.status(409).json({ error: 'not_configured', message: 'Set CVENT_CLIENT_ID and CVENT_CLIENT_SECRET in Modules → Cvent first.' });
      return null;
    }
    return createCventClient({ ...creds, log: (m) => console.log(`[cvent] ${m}`) });
  }

  router.get('/events/:eventId/settings', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const eventId = uuidParam(req, res, 'eventId');
    if (!eventId) return;
    try {
      const event = await loadCventEvent(service, eventId);
      if (!event) { res.status(404).json({ error: 'event_not_found' }); return; }
      const [status, config] = await Promise.all([eventSyncStatus(service, eventId), loadModuleConfig(service)]);
      res.json({
        settings: {
          cvent_event_id: event.cvent_event_id,
          cvent_event_code: (event as Record<string, unknown>).cvent_event_code ?? null,
          cvent_admission_item_id: event.cvent_admission_item_id,
          cvent_sync_enabled: event.cvent_sync_enabled === true,
        },
        status,
        credentials_configured: parseCredentials(config) !== null,
      });
    } catch (e) {
      console.error('[cvent] settings read failed:', e);
      res.status(500).json({ error: 'settings_read_failed' });
    }
  });

  // Mass-assignment guard: only these four columns, each validated.
  router.put('/events/:eventId/settings', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const eventId = uuidParam(req, res, 'eventId');
    if (!eventId) return;

    const body = req.body ?? {};
    const text = (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v !== 'string') return undefined;
      const s = v.trim();
      if (s.length > 200 || /[\r\n]/.test(s)) return undefined;
      return s || null;
    };
    const patch = {
      cvent_event_id: text(body.cvent_event_id),
      cvent_event_code: text(body.cvent_event_code),
      cvent_admission_item_id: text(body.cvent_admission_item_id),
      cvent_sync_enabled: body.cvent_sync_enabled === true,
    };
    if (Object.values(patch).some((v) => v === undefined)) {
      res.status(400).json({ error: 'invalid_settings', message: 'ids must be strings of at most 200 characters' });
      return;
    }
    if (patch.cvent_sync_enabled && (!patch.cvent_event_id || !patch.cvent_admission_item_id)) {
      res.status(400).json({ error: 'invalid_settings', message: 'Live sync needs a Cvent event id and an admission item.' });
      return;
    }

    try {
      const existing = await loadCventEvent(service, eventId);
      if (!existing) { res.status(404).json({ error: 'event_not_found' }); return; }
      const { error } = await service.from('events').update(patch).eq('id', eventId);
      if (error) throw new Error(error.message);
      res.json({ ok: true, settings: patch });
    } catch (e) {
      console.error('[cvent] settings save failed:', e);
      res.status(500).json({ error: 'settings_save_failed' });
    }
  });

  router.get('/events/:eventId/admission-items', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const eventId = uuidParam(req, res, 'eventId');
    if (!eventId) return;
    try {
      const event = await loadCventEvent(service, eventId);
      if (!event) { res.status(404).json({ error: 'event_not_found' }); return; }
      if (!event.cvent_event_id) { res.status(400).json({ error: 'no_cvent_event_id', message: 'Save a Cvent event id first.' }); return; }
      const cvent = await cventClientOrNull(res);
      if (!cvent) return;
      const result = await cvent.listAdmissionItems(event.cvent_event_id);
      if (!result.success) { res.status(502).json({ error: 'cvent_error', message: result.error }); return; }
      res.json({ items: result.items ?? [] });
    } catch (e) {
      console.error('[cvent] admission items failed:', e);
      res.status(500).json({ error: 'admission_items_failed' });
    }
  });

  // Registrant search for the test-sync picker. The search term is stripped of
  // PostgREST filter metacharacters before it reaches .or().
  router.get('/events/:eventId/registrants', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const eventId = uuidParam(req, res, 'eventId');
    if (!eventId) return;
    const q = typeof req.query?.q === 'string' ? req.query.q : '';
    const safe = q.replace(/[,()*\\%_]/g, '').trim().slice(0, 100);
    if (safe.length < 2) { res.json({ registrants: [] }); return; }
    try {
      const { data: people, error: pErr } = await service
        .from('people')
        .select('id, email, attributes')
        .or(`email.ilike.%${safe}%,attributes->>first_name.ilike.%${safe}%,attributes->>last_name.ilike.%${safe}%`)
        .limit(25);
      if (pErr) throw new Error(pErr.message);
      if (!people?.length) { res.json({ registrants: [] }); return; }

      const byPerson = new Map(people.map((p) => [p.id, p]));
      const { data: regs, error: rErr } = await service
        .from('events_registrations')
        .select('id, person_id, status')
        .eq('event_id', eventId)
        .in('status', [...ACTIVE_STATUSES])
        .in('person_id', [...byPerson.keys()])
        .limit(10);
      if (rErr) throw new Error(rErr.message);

      const registrants = (regs ?? []).map((r) => {
        const p = byPerson.get(r.person_id);
        const f = badgeFields(p?.email ?? '', p?.attributes ?? null);
        const name = [f.firstName, f.lastName].filter(Boolean).join(' ');
        return { id: r.id, email: f.email, name, status: r.status };
      });
      res.json({ registrants });
    } catch (e) {
      console.error('[cvent] registrant search failed:', e);
      res.status(500).json({ error: 'registrant_search_failed' });
    }
  });

  router.post('/events/:eventId/sync-now', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const eventId = uuidParam(req, res, 'eventId');
    if (!eventId) return;
    try {
      const event = await loadCventEvent(service, eventId);
      if (!event) { res.status(404).json({ error: 'event_not_found' }); return; }
      if (!isEventConfigured(event)) {
        res.status(400).json({ error: 'not_configured', message: 'Save a Cvent event id and an admission item first.' });
        return;
      }
      const cvent = await cventClientOrNull(res);
      if (!cvent) return;
      const settings = parseSyncSettings(await loadModuleConfig(service));
      const summary = await syncEvent(
        { db: service, cvent, log: (m) => console.warn(m) },
        event,
        {
          deadline: Date.now() + SYNC_NOW_BUDGET_MS,
          batchSize: settings.batchSize,
          maxAttempts: settings.maxAttempts,
          pauseMs: settings.pauseMs,
        },
      );
      const status = await eventSyncStatus(service, eventId);
      res.json({ ...summary, status });
    } catch (e) {
      console.error('[cvent] sync-now failed:', e);
      res.status(500).json({ error: 'sync_failed' });
    }
  });

  router.post('/registrations/:registrationId/sync', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const registrationId = uuidParam(req, res, 'registrationId');
    if (!registrationId) return;
    try {
      const { data: reg, error } = await service
        .from('events_registrations')
        .select('id, event_id, person_id, status, people!inner(email, attributes)')
        .eq('id', registrationId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!reg) { res.status(404).json({ error: 'registration_not_found' }); return; }

      const event = await loadCventEvent(service, reg.event_id);
      if (!isEventConfigured(event)) {
        res.status(400).json({ error: 'not_configured', message: 'The event has no Cvent event id or admission item.' });
        return;
      }
      const cvent = await cventClientOrNull(res);
      if (!cvent) return;

      const person = Array.isArray(reg.people) ? reg.people[0] : reg.people;
      if (!person?.email) { res.status(400).json({ error: 'no_email' }); return; }

      const { data: ledger } = await service
        .from('cvent_registration_sync')
        .select('attempts')
        .eq('registration_id', registrationId)
        .maybeSingle();

      const result = await syncOneRegistration(
        { db: service, cvent, log: (m) => console.warn(m) },
        event,
        {
          registration_id: reg.id,
          person_id: reg.person_id,
          email: person.email,
          attributes: person.attributes ?? null,
          attempts: ledger?.attempts ?? 0,
        },
      );
      res.json(result);
    } catch (e) {
      console.error('[cvent] single sync failed:', e);
      res.status(500).json({ error: 'sync_failed' });
    }
  });

  app.use('/api/modules/cvent', router);
}
