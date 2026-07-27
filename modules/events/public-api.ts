import type { PublicApiContext } from '@gatewaze/shared';
import type { Router, Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Fields safe to expose via the public API — never use select('*') */
export const PUBLIC_EVENT_FIELDS = [
  'id', 'event_id', 'event_title', 'event_description', 'listing_intro',
  'event_start', 'event_end', 'event_timezone',
  'event_city', 'event_country_code', 'event_region', 'event_location',
  'venue_address', 'event_link', 'event_logo', 'event_type',
  'event_topics', 'screenshot_url',
  'enable_registration', 'enable_native_registration',
  'content_category',
] as const;

// Columns as they exist on the events_speakers_with_details view. The
// previous list ('name', 'title', 'bio', …) never matched the view — every
// speakers call 500'd with "column … does not exist".
const PUBLIC_SPEAKER_FIELDS = [
  'id', 'full_name', 'job_title', 'company', 'speaker_bio', 'avatar_url',
  'linkedin_url', 'role', 'sort_order', 'is_featured', 'speaker_topic',
  'talk_title', 'talk_synopsis',
] as const;

const PUBLIC_SPONSOR_FIELDS = [
  'id', 'sponsor_name', 'sponsor_logo_url', 'sponsorship_tier',
  'tier', 'booth_number', 'is_active',
] as const;

export function registerPublicApi(router: Router, ctx: PublicApiContext) {
  const supabase = ctx.supabase as SupabaseClient;

  // The PUBLISHED rule — must match the portal (sitemap.ts): an event is
  // public only when it is BOTH live in production AND listed. is_listed
  // alone leaks placeholder/internal drafts ("Town Hall N - Placeholder")
  // that are listed but not yet live.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const publicOnly = (q: any) => q.eq('is_live_in_production', true).eq('is_listed', true);

  // `id` is a uuid column — comparing it against a short event_id slug makes
  // PostgREST reject the whole query (invalid uuid input), so `.or(id.eq.X,
  // event_id.eq.X)` can never serve slug lookups. Branch on the key shape.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byIdOrSlug = (q: any, key: string) =>
    UUID_RE.test(key) ? q.eq('id', key) : q.eq('event_id', key);

  /**
   * Resolve an id-or-slug to a PUBLIC event's UUID, or null. The speakers /
   * sponsors sub-routes must gate on the parent event's visibility — querying
   * their tables directly would serve data for unpublished events.
   */
  async function resolvePublicEventUuid(idOrSlug: string): Promise<string | null> {
    const { data } = await byIdOrSlug(
      publicOnly(supabase.from('events').select('id')),
      idOrSlug,
    ).maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  }

  // GET /api/v1/events
  router.get('/', ctx.requireScope('read'), async (req: Request, res: Response) => {
    try {
      const { limit, offset } = ctx.parsePagination(req.query);
      const fields = ctx.parseFields(req.query.fields, [...PUBLIC_EVENT_FIELDS], [...PUBLIC_EVENT_FIELDS]);

      let query = publicOnly(
        supabase
          .from('events')
          .select(fields.join(','), { count: 'exact' }),
      )
        .order('event_start', { ascending: true })
        .range(offset, offset + limit - 1);

      if (req.query.q) query = query.ilike('event_title', `%${req.query.q}%`);
      if (req.query.city) query = query.ilike('event_city', `%${req.query.city}%`);
      if (req.query.type) query = query.eq('event_type', req.query.type);
      if (req.query.topics) query = query.overlaps('event_topics', req.query.topics.split(','));
      if (req.query.from) query = query.gte('event_start', req.query.from);
      if (req.query.to) query = query.lte('event_start', req.query.to);
      if (req.query.content_category) {
        const cats = String(req.query.content_category).split(',').map((s) => s.trim()).filter(Boolean);
        query = cats.length > 1 ? query.in('content_category', cats) : query.eq('content_category', cats[0]);
      }

      // Filter by calendar via subquery — preserves all other filters
      if (req.query.calendar_id) {
        const { data: calEvents } = await supabase
          .from('calendars_events')
          .select('event_id')
          .eq('calendar_id', req.query.calendar_id);
        const eventIds = ((calEvents ?? []) as Array<{ event_id: string }>).map((ce) => ce.event_id);
        if (eventIds.length === 0) {
          ctx.setCache(res, { kind: 'public', maxAge: 60, sMaxAge: 300 });
          return res.json({
            data: [],
            pagination: { total: 0, limit, offset, has_more: false },
            _links: { self: req.originalUrl },
          });
        }
        query = query.in('id', eventIds);
      }

      const { data, count, error } = await query;
      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });

      ctx.setCache(res, { kind: 'public', maxAge: 60, sMaxAge: 300 });
      const hasMore = offset + limit < (count || 0);
      res.json({
        data,
        pagination: { total: count, limit, offset, has_more: hasMore },
        _links: {
          self: req.originalUrl,
          ...(hasMore ? { next: `${req.baseUrl}?offset=${offset + limit}&limit=${limit}` } : {}),
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === 'VALIDATION_ERROR') {
        return res.status(400).json({ error: err });
      }
      console.error('[events] public-api list error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/events/metrics — registration metrics per event, ALL events
  // regardless of publish status. Requires the events:metrics scope:
  // registrant numbers are operational data, deliberately NOT part of the
  // public read surface (the keyless MCP profile never sees this tool) — and
  // because the scope already gates access, the published-only rule that
  // protects the keyless surface does not apply here. Each row carries
  // publish_state + is_listed so consumers can tell live events from drafts.
  // Registered BEFORE /:id so the literal path isn't swallowed by the param
  // route.
  router.get('/metrics', ctx.requireScope('metrics'), async (req: Request, res: Response) => {
    try {
      const { limit, offset } = ctx.parsePagination(req.query);
      // Cap the page: counts are computed per-event (three head-count
      // queries each) — 50 events = 150 cheap parallel counts, still snappy.
      const pageLimit = Math.min(limit, 50);

      let query = supabase
        .from('events')
        .select('id, event_id, event_title, event_start, event_end, event_city, event_country_code, event_type, event_location, publish_state, is_listed', { count: 'exact' })
        .order('event_start', { ascending: false })
        .range(offset, offset + pageLimit - 1);
      if (req.query.q) query = query.ilike('event_title', `%${req.query.q}%`);
      if (req.query.from) query = query.gte('event_start', req.query.from);
      if (req.query.to) query = query.lte('event_start', req.query.to);
      if (req.query.calendar_id) {
        const { data: calEvents } = await supabase
          .from('calendars_events')
          .select('event_id')
          .eq('calendar_id', req.query.calendar_id);
        const ids = ((calEvents ?? []) as Array<{ event_id: string }>).map((ce) => ce.event_id);
        if (ids.length === 0) {
          return res.json({ data: [], pagination: { total: 0, limit: pageLimit, offset, has_more: false } });
        }
        query = query.in('id', ids);
      }

      const { data: events, error, count } = await query;
      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });

      // Exact per-event counts via head requests — immune to PostgREST's
      // 1000-row response cap, which a naive fetch-and-count would hit.
      const rows = await Promise.all(
        ((events ?? []) as Array<Record<string, unknown>>).map(async (ev) => {
          const [registrants, checkedIn, cancelled] = await Promise.all([
            supabase.from('events_registrations').select('id', { count: 'exact', head: true })
              .eq('event_id', ev.id).neq('status', 'cancelled'),
            supabase.from('events_registrations').select('id', { count: 'exact', head: true })
              .eq('event_id', ev.id).neq('status', 'cancelled').eq('checked_in', true),
            supabase.from('events_registrations').select('id', { count: 'exact', head: true })
              .eq('event_id', ev.id).eq('status', 'cancelled'),
          ]);
          return {
            ...ev,
            is_published: ev.publish_state === 'published' && ev.is_listed === true,
            registrations: {
              registrants: registrants.count ?? 0,
              checked_in: checkedIn.count ?? 0,
              cancelled: cancelled.count ?? 0,
            },
          };
        }),
      );

      ctx.setCache(res, { kind: 'no-store' });
      res.json({
        data: rows,
        pagination: { total: count ?? 0, limit: pageLimit, offset, has_more: offset + rows.length < (count ?? 0) },
        _links: { self: req.originalUrl },
      });
    } catch (err) {
      console.error('[events] public-api metrics error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  /**
   * Page through events_registrations for a set of event UUIDs, returning
   * per-event counts. Used by the aggregate metrics paths below — PostgREST
   * caps responses at 1000 rows, so this pages explicitly (30k-row ceiling,
   * plenty above current data volume; staff-only surfaces, no caching).
   */
  async function aggregateRegistrations(eventIds: string[]): Promise<Map<string, { registrants: number; checked_in: number; cancelled: number }>> {
    const agg = new Map<string, { registrants: number; checked_in: number; cancelled: number }>();
    const CHUNK = 200; // keep the .in() filter within sane URL length
    for (let c = 0; c < eventIds.length; c += CHUNK) {
      const chunk = eventIds.slice(c, c + CHUNK);
      for (let page = 0; page < 30; page++) {
        const { data, error } = await supabase
          .from('events_registrations')
          .select('event_id, status, checked_in')
          .in('event_id', chunk)
          .range(page * 1000, page * 1000 + 999);
        if (error) throw new Error(error.message);
        for (const r of (data ?? []) as Array<{ event_id: string; status: string | null; checked_in: boolean | null }>) {
          const a = agg.get(r.event_id) ?? { registrants: 0, checked_in: 0, cancelled: 0 };
          if (r.status === 'cancelled') a.cancelled++;
          else {
            a.registrants++;
            if (r.checked_in) a.checked_in++;
          }
          agg.set(r.event_id, a);
        }
        if ((data ?? []).length < 1000) break;
      }
    }
    return agg;
  }

  // GET /api/v1/events/metrics/summary — platform-wide registration totals
  // (events:metrics). One call answers "how many people have registered
  // across all our events": total events, registrations, check-ins,
  // cancellations, plus how many events actually log attendance — most
  // don't, so consumers can caveat attendance numbers honestly. Optional
  // q/from/to filters scope the totals; sort=registrants returns the
  // top events by registrants (limit, default 10) alongside the totals.
  router.get('/metrics/summary', ctx.requireScope('metrics'), async (req: Request, res: Response) => {
    try {
      let query = supabase
        .from('events')
        .select('id, event_id, event_title, event_start, event_city, event_country_code, event_type, publish_state, is_listed')
        .order('event_start', { ascending: false })
        .limit(2000);
      if (req.query.q) query = query.ilike('event_title', `%${req.query.q}%`);
      if (req.query.from) query = query.gte('event_start', req.query.from);
      if (req.query.to) query = query.lte('event_start', req.query.to);
      const { data: events, error } = await query;
      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });

      const rows = (events ?? []) as Array<Record<string, unknown>>;
      const agg = await aggregateRegistrations(rows.map((e) => e.id as string));

      const totals = { events: rows.length, registrants: 0, checked_in: 0, cancelled: 0, events_with_checkins: 0 };
      for (const a of agg.values()) {
        totals.registrants += a.registrants;
        totals.checked_in += a.checked_in;
        totals.cancelled += a.cancelled;
        if (a.checked_in > 0) totals.events_with_checkins++;
      }

      const limit = Math.min(parseInt(String(req.query.limit)) || 10, 50);
      const top = rows
        .map((ev) => ({
          event_id: ev.event_id,
          event_title: ev.event_title,
          event_start: ev.event_start,
          event_city: ev.event_city,
          event_country_code: ev.event_country_code,
          event_type: ev.event_type,
          is_published: ev.publish_state === 'published' && ev.is_listed === true,
          registrations: agg.get(ev.id as string) ?? { registrants: 0, checked_in: 0, cancelled: 0 },
        }))
        .sort((a, b) => b.registrations.registrants - a.registrations.registrants)
        .slice(0, limit);

      ctx.setCache(res, { kind: 'no-store' });
      res.json({
        data: {
          totals,
          attendance_note: `check-ins are logged for only ${totals.events_with_checkins} of ${totals.events} events — attendance totals undercount reality`,
          top_events_by_registrants: top,
        },
        _links: { self: req.originalUrl },
      });
    } catch (err) {
      console.error('[events] public-api metrics summary error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/events/registrant-breakdown — AGGREGATED registration-form
  // answers per event (events:metrics). Returns each question asked on the
  // form with answer counts — never registrant-level rows, so no PII leaves
  // the API. Forms vary per event (Pune asked a combined "company - role"
  // field), so consumers get the raw aggregation and do their own binning.
  router.get('/registrant-breakdown', ctx.requireScope('metrics'), async (req: Request, res: Response) => {
    try {
      let query = supabase
        .from('events')
        .select('id, event_id, event_title, event_start, event_city, event_country_code, publish_state, is_listed')
        .order('event_start', { ascending: false })
        .limit(Math.min(parseInt(String(req.query.limit)) || 3, 5));
      if (req.query.q) query = query.ilike('event_title', `%${req.query.q}%`);
      if (req.query.id) query = byIdOrSlug(query, String(req.query.id));
      if (!req.query.q && !req.query.id) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'q or id required' } });
      }
      const { data: events, error } = await query;
      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });

      const out = [] as Array<Record<string, unknown>>;
      for (const ev of (events ?? []) as Array<Record<string, unknown>>) {
        // question label -> normalized answer -> count
        const questions = new Map<string, Map<string, number>>();
        let registrants = 0;
        let answered = 0;
        for (let page = 0; page < 30; page++) {
          const { data, error: regErr } = await supabase
            .from('events_registrations')
            .select('registration_metadata, status')
            .eq('event_id', ev.id as string)
            .range(page * 1000, page * 1000 + 999);
          if (regErr) throw new Error(regErr.message);
          for (const r of (data ?? []) as Array<{ registration_metadata: { registration_answers?: Array<{ label?: string; answer?: string }> } | null; status: string | null }>) {
            if (r.status === 'cancelled') continue;
            registrants++;
            const answers = r.registration_metadata?.registration_answers ?? [];
            if (answers.length > 0) answered++;
            for (const a of answers) {
              const label = (a.label ?? '').trim();
              const value = (a.answer ?? '').trim().toLowerCase();
              if (!label || !value) continue;
              const byAnswer = questions.get(label) ?? new Map<string, number>();
              byAnswer.set(value, (byAnswer.get(value) ?? 0) + 1);
              questions.set(label, byAnswer);
            }
          }
          if ((data ?? []).length < 1000) break;
        }
        out.push({
          event_id: ev.event_id,
          event_title: ev.event_title,
          event_start: ev.event_start,
          event_city: ev.event_city,
          event_country_code: ev.event_country_code,
          is_published: ev.publish_state === 'published' && ev.is_listed === true,
          registrants,
          registrants_with_answers: answered,
          questions: [...questions.entries()].map(([label, byAnswer]) => {
            const sorted = [...byAnswer.entries()].sort((a, b) => b[1] - a[1]);
            return {
              label,
              answered: sorted.reduce((s, [, n]) => s + n, 0),
              answers: sorted.slice(0, 100).map(([value, count]) => ({ value, count })),
              distinct_answers: sorted.length,
            };
          }),
        });
      }

      ctx.setCache(res, { kind: 'no-store' });
      res.json({ data: out, _links: { self: req.originalUrl } });
    } catch (err) {
      console.error('[events] public-api registrant-breakdown error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/events/nearby — PUBLISHED upcoming events within radius_km
  // of lat/lng, sorted soonest-first. Public surface (events:read): only the
  // published rule's events, coordinates come from event_location.
  router.get('/nearby', ctx.requireScope('read'), async (req: Request, res: Response) => {
    try {
      const lat = parseFloat(String(req.query.lat));
      const lng = parseFloat(String(req.query.lng));
      if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'valid lat and lng required' } });
      }
      const radiusKm = Math.min(Math.max(parseFloat(String(req.query.radius_km)) || 150, 1), 5000);
      const limit = Math.min(parseInt(String(req.query.limit)) || 10, 50);
      const includePast = req.query.include_past === 'true';

      let query = publicOnly(
        supabase
          .from('events')
          .select('id, event_id, event_title, event_start, event_end, event_timezone, event_city, event_region, event_country_code, event_type, event_location, venue_address'),
      )
        .not('event_location', 'is', null)
        .order('event_start', { ascending: true })
        .limit(1000);
      if (!includePast) query = query.gte('event_start', new Date().toISOString());
      const { data, error } = await query;
      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });

      const toRad = (d: number) => (d * Math.PI) / 180;
      const haversineKm = (aLat: number, aLng: number, bLat: number, bLng: number) => {
        const dLat = toRad(bLat - aLat);
        const dLng = toRad(bLng - aLng);
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
        return 2 * 6371 * Math.asin(Math.sqrt(h));
      };

      const rows = ((data ?? []) as Array<Record<string, unknown>>)
        .map((ev) => {
          const [evLat, evLng] = String(ev.event_location ?? '').split(',').map((s) => parseFloat(s.trim()));
          if (!isFinite(evLat) || !isFinite(evLng)) return null;
          const { event_location: _drop, id: _dropId, ...pub } = ev;
          return { ...pub, distance_km: Math.round(haversineKm(lat, lng, evLat, evLng)) };
        })
        .filter((ev): ev is NonNullable<typeof ev> => ev !== null && (ev.distance_km as number) <= radiusKm)
        .slice(0, limit);

      ctx.setCache(res, { kind: 'public', maxAge: 60, sMaxAge: 300 });
      res.json({ data: rows, query: { lat, lng, radius_km: radiusKm }, _links: { self: req.originalUrl } });
    } catch (err) {
      console.error('[events] public-api nearby error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/events/my-registrations — a PERSON's own registrations,
  // for the MCP OAuth surface (events:self — held only by trusted internal
  // callers; the MCP layer always passes the authenticated token's own
  // person_id, so users only ever see themselves).
  router.get('/my-registrations', ctx.requireScope('self'), async (req: Request, res: Response) => {
    try {
      const personId = String(req.query.person_id ?? '');
      if (!UUID_RE.test(personId)) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'person_id (uuid) required' } });
      }
      const { data, error } = await supabase
        .from('events_registrations')
        .select('status, checked_in, registered_at, events!inner(event_id, event_title, event_start, event_end, event_timezone, event_city, event_country_code, event_type)')
        .eq('person_id', personId)
        .order('registered_at', { ascending: false })
        .limit(200);
      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });

      const now = Date.now();
      type RegRow = Record<string, unknown> & { status: string | null; checked_in: boolean | null; registered_at: string; is_upcoming: boolean };
      const rows: RegRow[] = ((data ?? []) as Array<{ status: string | null; checked_in: boolean | null; registered_at: string; events: Record<string, unknown> | Record<string, unknown>[] }>)
        .map((r) => {
          const ev = ((Array.isArray(r.events) ? r.events[0] : r.events) ?? {}) as Record<string, unknown>;
          return {
            ...ev,
            status: r.status,
            checked_in: r.checked_in,
            registered_at: r.registered_at,
            is_upcoming: ev.event_start ? new Date(String(ev.event_start)).getTime() >= now : false,
          };
        });
      const active = rows.filter((r) => r.status !== 'cancelled');
      const upcoming = active
        .filter((r) => r.is_upcoming)
        .sort((a, b) => String(a.event_start).localeCompare(String(b.event_start)));

      ctx.setCache(res, { kind: 'no-store' });
      res.json({
        data: {
          counts: { total: active.length, upcoming: upcoming.length, cancelled: rows.length - active.length },
          next_event: upcoming[0] ?? null,
          registrations: rows,
        },
        _links: { self: req.originalUrl },
      });
    } catch (err) {
      console.error('[events] public-api my-registrations error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/events/:id
  router.get('/:id', ctx.requireScope('read'), async (req: Request, res: Response) => {
    try {
      const fields = ctx.parseFields(req.query.fields, [...PUBLIC_EVENT_FIELDS], [...PUBLIC_EVENT_FIELDS]);
      const { data, error } = await byIdOrSlug(
        publicOnly(supabase.from('events').select(fields.join(','))),
        req.params.id,
      ).single();

      if (error || !data) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Event not found' } });
      }

      ctx.setCache(res, { kind: 'public', maxAge: 60, sMaxAge: 600 });
      res.json({
        data,
        _links: {
          self: req.originalUrl,
          speakers: `${req.baseUrl}/${req.params.id}/speakers`,
          sponsors: `${req.baseUrl}/${req.params.id}/sponsors`,
        },
      });
    } catch (err) {
      console.error('[events] public-api get error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/events/:id/speakers
  router.get('/:id/speakers', ctx.requireScope('read'), async (req: Request, res: Response) => {
    try {
      const eventUuid = await resolvePublicEventUuid(req.params.id);
      if (!eventUuid) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Event not found' } });
      }
      const { data, error } = await supabase
        .from('events_speakers_with_details')
        .select(PUBLIC_SPEAKER_FIELDS.join(','))
        .eq('event_uuid', eventUuid)
        // Only confirmed speakers are public — pending/declined submissions
        // are not announced (mirrors the portal speakers rule).
        .eq('status', 'confirmed')
        .order('sort_order');

      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });

      ctx.setCache(res, { kind: 'public', maxAge: 60, sMaxAge: 300 });
      res.json({ data, _links: { self: req.originalUrl } });
    } catch (err) {
      console.error('[events] public-api speakers error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/events/:id/sponsors
  router.get('/:id/sponsors', ctx.requireScope('read'), async (req: Request, res: Response) => {
    try {
      const eventUuid = await resolvePublicEventUuid(req.params.id);
      if (!eventUuid) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Event not found' } });
      }
      const { data, error } = await supabase
        .from('events_sponsors')
        .select(PUBLIC_SPONSOR_FIELDS.join(','))
        .eq('event_id', eventUuid)
        .eq('is_active', true)
        .order('sponsorship_tier');

      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });

      ctx.setCache(res, { kind: 'public', maxAge: 60, sMaxAge: 300 });
      res.json({ data, _links: { self: req.originalUrl } });
    } catch (err) {
      console.error('[events] public-api sponsors error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });
}
