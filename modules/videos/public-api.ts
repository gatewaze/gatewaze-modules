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
export const PUBLIC_SUBJECT_TYPES = ['event', 'podcast_episode', 'talk', 'agenda_entry'] as const;

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

  /** Video ids linked to one subject, or a 400 for a malformed id. */
  async function videoIdsFor(type: 'event' | 'podcast_episode', raw: string): Promise<string[] | { error: string }> {
    if (!UUID_RE.test(raw)) throw badRequest(`Parameter "${type}" must be a UUID.`);
    const { data, error } = await supabase
      .from('video_subjects')
      .select('video_id')
      .eq('subject_type', type)
      .eq('subject_id', raw)
      .limit(SUBJECT_FILTER_CAP);
    if (error) return { error: error.message ?? 'subject lookup failed' };
    return [...new Set<string>((data ?? []).map((r: { video_id: string }) => String(r.video_id)))];
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
      for (const [type, raw] of [['event', event], ['podcast_episode', episode]] as const) {
        if (raw === undefined) continue;
        const found = await videoIdsFor(type, raw);
        if ('error' in found) return queryError(res, ctx, `${type} filter`, { message: found.error });
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

      const body: Record<string, unknown> = { ...(data as Record<string, unknown>) };
      if (!fields.includes('id')) delete body.id;
      body.subjects = (subj.data ?? []).map((s: { subject_type: string; subject_id: string }) => ({
        type: s.subject_type,
        id: s.subject_id,
      }));
      cache(res);
      res.json({ data: body });
    } catch (err) {
      sendError(res, err);
    }
  });
}
