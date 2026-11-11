// Public REST API for videos, mounted by the host at /api/v1/videos with
// API-key auth (scope videos:read). Same contract as /api/v1/events and
// /api/v1/podcasts: { data, pagination, _links } envelopes, ?fields= sparse
// fieldsets, limit/offset pagination, { error: { code, message } } errors.
//
// Reads only the videos_api_public view (migration 021), which applies the
// platform's public rule: published, visibility 'public', not keyword-hidden.
// A discovered video is a draft until it is published, and a private or
// unlisted upload never appears.
//
// ctx is the framework PublicApiContext: supabase, requireScope,
// parsePagination, parseFields, setCache. Typed loosely to keep host-only
// types out of the module build.

export const VIDEO_FIELDS = [
  'id',
  'provider',
  'provider_video_id',
  'url',
  'title',
  'description',
  'thumbnail_url',
  'duration_seconds',
  'published_at',
  'channel_id',
  'channel_title',
  'kind',
  'topics',
  'content_category',
  'created_at',
  'updated_at',
] as const;

/** What a video can be linked to in public. People are left out on purpose. */
export const PUBLIC_SUBJECT_TYPES = ['event', 'podcast', 'podcast_episode', 'talk', 'agenda_entry'] as const;

/** An event's short public code, as /api/v1/events and /api/v1/content use it. */
const EVENT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const KINDS = ['full', 'short', 'clip', 'trailer', 'livestream'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_RE = /^UC[A-Za-z0-9_-]{22}$/;
const TOPIC_RE = /^[a-z0-9][a-z0-9 _-]{0,63}$/i;
/** Ceiling on the ids an event or episode filter resolves to: they travel in the request URL as an in() list, so this keeps it well under proxy limits. */
const SUBJECT_FILTER_CAP = 200;

type ApiError = { statusCode: number; code: string; message: string };

function badRequest(message: string): ApiError {
  return { statusCode: 400, code: 'VALIDATION_ERROR', message };
}

function one(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function parseDate(name: string, raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw badRequest(`Parameter "${name}" must be an RFC 3339 date.`);
  }
  return new Date(raw).toISOString();
}

/** Search text with PostgREST filter metacharacters removed (security-boundaries.md). */
export function safeSearch(raw: string | undefined): string {
  return String(raw ?? '').replace(/[,()*\\%:]/g, '').trim().slice(0, 100);
}

function sendError(res: any, err: unknown): void {
  const e = err as Partial<ApiError>;
  if (e && typeof e.statusCode === 'number' && typeof e.code === 'string') {
    res.status(e.statusCode).json({ error: { code: e.code, message: e.message ?? '' } });
    return;
  }
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}

function queryError(res: any, ctx: any, where: string, error: { message?: string }): void {
  ctx.logger?.warn?.(`[videos] public-api ${where} failed`, { error: error?.message });
  res.status(500).json({ error: { code: 'QUERY_ERROR', message: 'The query could not be completed.' } });
}

function page(req: any, rows: unknown[], count: number | null, limit: number, offset: number) {
  const total = count ?? null;
  const hasMore = total !== null ? offset + rows.length < total : rows.length === limit;
  const links: Record<string, string> = { self: req.originalUrl };
  if (hasMore) {
    const u = new URL(req.originalUrl, 'http://x');
    u.searchParams.set('offset', String(offset + limit));
    u.searchParams.set('limit', String(limit));
    links.next = `${u.pathname}${u.search}`;
  }
  return { data: rows, pagination: { total, limit, offset, has_more: hasMore }, _links: links };
}

export function registerPublicApi(router: any, ctx: any): void {
  const supabase = ctx.supabase;
  const read = ctx.requireScope('read');
  const cache = (res: any) => ctx.setCache(res, { kind: 'public', maxAge: 300, sMaxAge: 600 });

  // The events API's own notion of a public event: live in production and
  // listed. Used both to resolve ?event= and to gate the event ids a video's
  // detail reveals, so neither says anything about an unpublished event.
  const publicEvents = () => supabase.from('events').select('id').eq('is_live_in_production', true).eq('is_listed', true);

  /** A public event's uuid from its uuid or its short code, or null. */
  async function publicEventUuid(raw: string): Promise<string | null | { error: string }> {
    const isUuid = UUID_RE.test(raw);
    if (!isUuid && !EVENT_CODE_RE.test(raw)) throw badRequest('Parameter "event" must be an event id or event code.');
    const { data, error } = await (isUuid ? publicEvents().eq('id', raw) : publicEvents().eq('event_id', raw)).limit(1).maybeSingle();
    if (error) return { error: error.message ?? 'event lookup failed' };
    return (data as { id: string } | null)?.id ?? null;
  }

  /** A table that is not there because its module is not installed. */
  function missingTable(error: { code?: string; message?: string } | null): boolean {
    return !!error && (error.code === '42P01' || error.code === 'PGRST205'
      || /relation .* does not exist|could not find the table/i.test(error.message ?? ''));
  }

  function idsFrom(rows: Array<{ video_id: string }> | null): string[] {
    return (rows ?? []).map((r) => String(r.video_id));
  }

  /**
   * Videos linked to one public event: to the event itself, to any of its
   * agenda entries or talks (how per-talk recordings are linked), or through
   * the older event_videos table the event pages read.
   */
  async function videoIdsForEvent(raw: string): Promise<string[] | { error: string }> {
    const uuid = await publicEventUuid(raw);
    if (uuid && typeof uuid === 'object') return uuid;
    if (!uuid) return [];

    // events_agenda_entries belongs to event-agenda, which not every brand
    // installs; without it an event simply has no agenda entries.
    const entries = await supabase.from('events_agenda_entries').select('id').eq('event_uuid', uuid).limit(SUBJECT_FILTER_CAP);
    if (entries.error && !missingTable(entries.error)) return { error: entries.error.message ?? 'agenda lookup failed' };
    const entryIds = (entries.data ?? []).map((r: { id: string }) => String(r.id));

    const direct = await supabase.from('video_subjects').select('video_id').eq('subject_type', 'event').eq('subject_id', uuid).limit(SUBJECT_FILTER_CAP);
    if (direct.error) return { error: direct.error.message ?? 'subject lookup failed' };
    const viaEntries = entryIds.length
      ? await supabase.from('video_subjects').select('video_id').in('subject_type', ['agenda_entry', 'talk']).in('subject_id', entryIds).limit(SUBJECT_FILTER_CAP)
      : { data: [], error: null };
    if (viaEntries.error) return { error: viaEntries.error.message ?? 'subject lookup failed' };
    const legacy = await supabase.from('event_videos').select('video_id').eq('event_uuid', uuid).limit(SUBJECT_FILTER_CAP);
    if (legacy.error && !missingTable(legacy.error)) return { error: legacy.error.message ?? 'event_videos lookup failed' };

    return [...new Set<string>([...idsFrom(direct.data), ...idsFrom(viaEntries.data), ...idsFrom(legacy.data)])].slice(0, SUBJECT_FILTER_CAP);
  }

  /** Videos linked to one podcast episode. */
  async function videoIdsForEpisode(raw: string): Promise<string[] | { error: string }> {
    if (!UUID_RE.test(raw)) throw badRequest('Parameter "podcast_episode" must be a UUID.');
    const { data, error } = await supabase
      .from('video_subjects')
      .select('video_id')
      .eq('subject_type', 'podcast_episode')
      .eq('subject_id', raw)
      .limit(SUBJECT_FILTER_CAP);
    if (error) return { error: error.message ?? 'subject lookup failed' };
    return [...new Set<string>(idsFrom(data))];
  }

  // GET / — public videos, newest first.
  router.get('/', read, async (req: any, res: any) => {
    try {
      const { limit, offset } = ctx.parsePagination(req.query);
      const fields = ctx.parseFields(one(req.query.fields), [...VIDEO_FIELDS]);
      const channel = one(req.query.channel);
      const kind = one(req.query.kind);
      const from = parseDate('from', one(req.query.from));
      const to = parseDate('to', one(req.query.to));
      const q = safeSearch(one(req.query.q));
      const topicsRaw = one(req.query.topics);
      const event = one(req.query.event);
      const episode = one(req.query.podcast_episode);

      if (channel !== undefined && !CHANNEL_RE.test(channel)) {
        throw badRequest('Parameter "channel" must be a YouTube channel id (UC…).');
      }
      if (kind !== undefined && !(KINDS as readonly string[]).includes(kind)) {
        throw badRequest(`Parameter "kind" must be one of: ${KINDS.join(', ')}.`);
      }
      if (event !== undefined && episode !== undefined) {
        throw badRequest('Use either "event" or "podcast_episode", not both.');
      }

      let ids: string[] | null = null;
      if (event !== undefined || episode !== undefined) {
        const found = event !== undefined ? await videoIdsForEvent(event) : await videoIdsForEpisode(episode!);
        if ('error' in found) return queryError(res, ctx, 'subject filter', { message: found.error });
        ids = found;
      }
      if (ids !== null && ids.length === 0) {
        cache(res);
        return res.json(page(req, [], 0, limit, offset));
      }

      let query = supabase
        .from('videos_api_public')
        .select(fields.join(','), { count: 'exact' })
        .order('published_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
        .range(offset, offset + limit - 1);

      if (ids !== null) query = query.in('id', ids);
      if (channel) query = query.eq('channel_id', channel);
      if (kind) query = query.eq('kind', kind);
      if (from) query = query.gte('published_at', from);
      if (to) query = query.lte('published_at', to);
      if (q) query = query.or(`title.ilike.%${q}%,description.ilike.%${q}%`);
      if (topicsRaw) {
        const topics = topicsRaw.split(',').map((t) => t.trim()).filter(Boolean);
        if (topics.length > 20 || topics.some((t) => !TOPIC_RE.test(t))) {
          throw badRequest('Parameter "topics" must be up to 20 comma-separated topic names.');
        }
        if (topics.length) query = query.overlaps('topics', topics);
      }

      const { data, error, count } = await query;
      if (error) return queryError(res, ctx, 'list videos', error);
      cache(res);
      res.json(page(req, data ?? [], count, limit, offset));
    } catch (err) {
      sendError(res, err);
    }
  });

  // GET /:id — one public video, by Gatewaze id or YouTube video id, with the
  // events, talks and podcast episodes it is linked to.
  router.get('/:id', read, async (req: any, res: any) => {
    try {
      const id = String(req.params.id ?? '');
      const isUuid = UUID_RE.test(id);
      if (!isUuid && !YOUTUBE_ID_RE.test(id)) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Video not found' } });
      }
      const fields = ctx.parseFields(one(req.query.fields), [...VIDEO_FIELDS]);
      // The id is always selected: the subjects lookup needs it.
      const select = [...new Set(['id', ...fields])].join(',');
      let query = supabase.from('videos_api_public').select(select);
      query = isUuid ? query.eq('id', id) : query.eq('provider', 'youtube').eq('provider_video_id', id);
      const { data, error } = await query.limit(1).maybeSingle();
      if (error) return queryError(res, ctx, 'get video', error);
      if (!data) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Video not found' } });

      const subj = await supabase
        .from('video_subjects')
        .select('subject_type, subject_id')
        .eq('video_id', (data as { id: string }).id)
        .in('subject_type', [...PUBLIC_SUBJECT_TYPES]);
      if (subj.error) return queryError(res, ctx, 'video subjects', subj.error);

      // Only links whose event is public, as the events API gates its own
      // sub-resources: an unlisted event's id is not this API's to reveal.
      // Podcast links are passed through; podcasts gate their own reads.
      const rows = (subj.data ?? []) as Array<{ subject_type: string; subject_id: string }>;
      const entryIds = rows.filter((s) => s.subject_type === 'agenda_entry' || s.subject_type === 'talk').map((s) => s.subject_id);
      const entryEvent = new Map<string, string>();
      if (entryIds.length) {
        const e = await supabase.from('events_agenda_entries').select('id, event_uuid').in('id', entryIds);
        if (e.error && !missingTable(e.error)) return queryError(res, ctx, 'subject events', e.error);
        for (const r of (e.data ?? []) as Array<{ id: string; event_uuid: string }>) entryEvent.set(String(r.id), String(r.event_uuid));
      }
      const eventIds = [...new Set<string>([
        ...rows.filter((s) => s.subject_type === 'event').map((s) => s.subject_id),
        ...entryEvent.values(),
      ])];
      const publicIds = new Set<string>();
      if (eventIds.length) {
        const p = await publicEvents().in('id', eventIds);
        if (p.error) return queryError(res, ctx, 'subject events', p.error);
        for (const r of (p.data ?? []) as Array<{ id: string }>) publicIds.add(String(r.id));
      }
      const visible = rows.filter((s) => {
        if (s.subject_type === 'event') return publicIds.has(s.subject_id);
        if (s.subject_type === 'agenda_entry' || s.subject_type === 'talk') {
          const ev = entryEvent.get(s.subject_id);
          return ev !== undefined && publicIds.has(ev);
        }
        return true;
      });

      const body: Record<string, unknown> = { ...(data as Record<string, unknown>) };
      if (!fields.includes('id')) delete body.id;
      body.subjects = visible.map((s) => ({ type: s.subject_type, id: s.subject_id }));
      cache(res);
      res.json({ data: body });
    } catch (err) {
      sendError(res, err);
    }
  });
}
