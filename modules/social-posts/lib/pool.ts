/**
 * The curated content pool: published items from the modules that land
 * content (blog posts and articles from content-sources, videos, events,
 * structured resources such as conference recaps), in one shape.
 *
 * "Curated" means publish_state = 'published' (what the Content Inbox sets
 * when an editor approves an item) and also publicly visible by the owning
 * module's own rule: blog posts and videos need status 'published' and
 * visibility 'public', resources need status 'published', and events need
 * is_listed. publish_state defaults to 'published' on rows that never went
 * through the Inbox (an admin's blog draft, a draft resource), so it is not
 * enough on its own. Each type's table belongs to
 * another module and any of them may be absent, so every query is isolated:
 * a missing table drops that type from the pool and the rest still load.
 *
 * Reads run with the service role after the route's admin check.
 */

import { isPoolType, type PoolItem, type PoolType } from './pool-types.js';

// The query builder is typed as any on purpose: the content tables belong to
// other modules and may be absent, so there are no generated row types to
// give supabase-js, and each adapter maps its rows through str()/safeUrl().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SupabaseLike = { from(table: string): any };

type QueryError = { code?: string; message?: string } | null | undefined;

/**
 * True when the error says the table is not there, i.e. its module is not
 * installed: Postgres 42P01, or PostgREST PGRST205 when its schema cache has
 * no such table. Any other error is a real failure and is logged or thrown.
 */
export function isMissingTable(error: QueryError | unknown): boolean {
  const e = (error ?? {}) as { code?: string; message?: string };
  return e.code === '42P01' || e.code === 'PGRST205'
    || /relation "[^"]+" does not exist|Could not find the table/i.test(String(e.message ?? ''));
}

function logQueryError(where: string, error: unknown): void {
  const e = error as { code?: string; message?: string } | null;
  console.error(`[social-posts] ${where}:`, e?.code ?? '', e?.message ?? String(error));
}

/** Thrown by loadItems when a content table answers with a real error. */
export class PoolQueryError extends Error {
  constructor(readonly table: string, cause: unknown) {
    super(`query on ${table} failed`, { cause });
    this.name = 'PoolQueryError';
  }
}

type Row = Record<string, unknown>;

// ── small helpers (exported for tests) ──────────────────────────────────────

/** Only absolute http(s) links reach a post or the admin UI. */
export function safeUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^https?:\/\/[^\s/?#]+/i.test(s) || /\s/.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The portal origin internal links are built on; null when the deployment sets none. */
export function portalBase(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.SITE_URL || env.PORTAL_URL || '').trim().replace(/\/+$/, '');
  return safeUrl(raw) ? raw : null;
}

function portalLink(base: string | null, path: string): string | null {
  return base ? safeUrl(`${base}${path}`) : null;
}

function isoDate(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', hellip: '…',
};

/** HTML to plain text for the prompt. Never rendered, so a crude pass is enough. */
export function htmlToText(html: unknown): string | null {
  if (typeof html !== 'string' || !html.trim()) return null;
  const text = html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-z]+|#39);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const code = Number(n);
      return code > 31 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

const LEGAL_SUFFIX = /,?\s+(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|gmbh|ag|s\.a|sa|n\.v|nv|b\.v|bv|plc|d\.o\.o|pte|pty|srl|s\.r\.l|oy|ab|as|kk)\.?$/i;

/** "Member: Cisco Systems, Inc." → "Cisco Systems". The name a post would @mention. */
export function memberDisplayName(ruleName: unknown): string | null {
  let name = String(ruleName ?? '').replace(/^\s*member:\s*/i, '').trim();
  for (let i = 0; i < 2; i++) name = name.replace(LEGAL_SUFFIX, '').trim();
  name = name.replace(/[,\s]+$/, '');
  return name ? name.slice(0, 120) : null;
}

/** Escape LIKE wildcards in a user search, and clamp it. */
export function likePattern(search: string): string {
  return `%${search.slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ── per-type adapters ───────────────────────────────────────────────────────

interface Adapter {
  table: string;
  /** Columns for the list (no long bodies). */
  listColumns: string;
  /** Columns for generation (with bodies). */
  loadColumns: string;
  /**
   * The owning module's "publicly visible" rule, applied to every list and
   * load query on top of publish_state = 'published'. q is the PostgREST
   * query builder, typed any for the reason given on SupabaseLike.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  visible: (q: any) => any;
  /** Extra filters for the list only (what the picker offers). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listScope?: (q: any) => any;
  titleColumn: string;
  orderColumn: string;
  map: (row: Row, base: string | null) => Omit<PoolItem, 'members'>;
}

export const ADAPTERS: Record<PoolType, Adapter> = {
  blog_post: {
    table: 'blog_posts',
    listColumns: 'id, title, slug, excerpt, meta_description, canonical_url, featured_image, og_image, published_at, is_external',
    loadColumns: 'id, title, slug, excerpt, meta_description, canonical_url, featured_image, og_image, published_at, is_external, content',
    visible: (q) => q.eq('status', 'published').eq('visibility', 'public'),
    titleColumn: 'title',
    orderColumn: 'published_at',
    map: (r, base) => ({
      contentType: 'blog_post',
      contentId: String(r.id),
      typeLabel: r.is_external ? 'Article' : 'Blog post',
      title: str(r.title) ?? '(untitled)',
      url: safeUrl(r.canonical_url) ?? (str(r.slug) ? portalLink(base, `/blog/${encodeURIComponent(String(r.slug))}`) : null),
      date: isoDate(r.published_at),
      location: null,
      summary: str(r.excerpt) ?? str(r.meta_description),
      body: htmlToText(r.content),
      thumbnailUrl: safeUrl(r.featured_image) ?? safeUrl(r.og_image),
    }),
  },
  video: {
    table: 'videos',
    listColumns: 'id, title, url, description, thumbnail_url, published_at, channel_title',
    loadColumns: 'id, title, url, description, thumbnail_url, published_at, channel_title, speakers',
    visible: (q) => q.eq('status', 'published').eq('visibility', 'public'),
    titleColumn: 'title',
    orderColumn: 'published_at',
    map: (r) => {
      const speakers = Array.isArray(r.speakers)
        ? (r.speakers as Array<{ name?: unknown; org?: unknown }>)
            .map((s) => [str(s?.name), str(s?.org)].filter(Boolean).join(', '))
            .filter(Boolean)
        : [];
      const description = str(r.description);
      return {
        contentType: 'video',
        contentId: String(r.id),
        typeLabel: 'Video',
        title: str(r.title) ?? '(untitled)',
        url: safeUrl(r.url),
        date: isoDate(r.published_at),
        location: null,
        summary: description ? description.slice(0, 280) : str(r.channel_title),
        body: [speakers.length ? `Speakers: ${speakers.join('; ')}` : null, description].filter(Boolean).join('\n\n') || null,
        thumbnailUrl: safeUrl(r.thumbnail_url),
      };
    },
  },
  event: {
    table: 'events',
    listColumns: 'id, event_title, event_link, event_slug, event_start, event_city, event_country_code, event_location, listing_intro, event_logo, event_featured_image',
    loadColumns: 'id, event_title, event_link, event_slug, event_start, event_end, event_timezone, event_city, event_country_code, event_location, event_type, listing_intro, event_description, event_logo, event_featured_image',
    // Upcoming and recent events only: a post promoting or recapping an event
    // from long ago is not what the picker is for, and events is the biggest
    // table in the pool.
    visible: (q) => q.eq('is_listed', true),
    listScope: (q) => q.gte('event_start', new Date(Date.now() - 90 * 86_400_000).toISOString()),
    titleColumn: 'event_title',
    orderColumn: 'event_start',
    map: (r, base) => ({
      contentType: 'event',
      contentId: String(r.id),
      typeLabel: 'Event',
      title: str(r.event_title) ?? '(untitled)',
      url: safeUrl(r.event_link) ?? (str(r.event_slug) ? portalLink(base, `/events/${encodeURIComponent(String(r.event_slug))}`) : null),
      date: isoDate(r.event_start),
      location: [str(r.event_location), str(r.event_city), str(r.event_country_code)].filter(Boolean).join(', ') || null,
      summary: str(r.listing_intro),
      body: [
        r.event_start ? `Starts: ${String(r.event_start)}${str(r.event_timezone) ? ` (${String(r.event_timezone)})` : ''}` : null,
        r.event_end ? `Ends: ${String(r.event_end)}` : null,
        str(r.event_type) ? `Type: ${String(r.event_type)}` : null,
        htmlToText(r.event_description),
      ].filter(Boolean).join('\n') || null,
      thumbnailUrl: safeUrl(r.event_featured_image) ?? safeUrl(r.event_logo),
    }),
  },
  sr_item: {
    table: 'sr_items',
    listColumns: 'id, title, slug, subtitle, external_url, featured_image_url, occurred_at, created_at, collection:sr_collections(name, slug)',
    loadColumns: 'id, title, slug, subtitle, external_url, featured_image_url, occurred_at, created_at, topics, collection:sr_collections(name, slug)',
    visible: (q) => q.eq('status', 'published'),
    titleColumn: 'title',
    orderColumn: 'created_at',
    map: (r, base) => {
      const collection = (r.collection ?? null) as { name?: unknown; slug?: unknown } | null;
      const cslug = str(collection?.slug);
      const topics = Array.isArray(r.topics) ? (r.topics as unknown[]).map(String).filter(Boolean) : [];
      return {
        contentType: 'sr_item',
        contentId: String(r.id),
        typeLabel: str(collection?.name) ?? 'Resource',
        title: str(r.title) ?? '(untitled)',
        url: safeUrl(r.external_url)
          ?? (cslug && str(r.slug) ? portalLink(base, `/resources/${encodeURIComponent(cslug)}/${encodeURIComponent(String(r.slug))}`) : null),
        date: isoDate(r.occurred_at) ?? isoDate(r.created_at),
        location: null,
        summary: str(r.subtitle),
        body: topics.length ? `Topics: ${topics.join(', ')}` : null,
        thumbnailUrl: safeUrl(r.featured_image_url),
      };
    },
  },
};

// ── members ─────────────────────────────────────────────────────────────────

/**
 * Member companies matched to each item by the content-keywords membership
 * rules (rules whose metadata.kind is 'membership'), keyed `type::id`.
 * Empty when content-keywords is not installed or nothing matched.
 */
export async function loadMembers(
  sb: SupabaseLike,
  items: Array<{ contentType: PoolType; contentId: string }>,
  /**
   * Throw on a real query error instead of returning no members. Saving a
   * draft uses this, so a passing database error can't wipe its mentions.
   */
  opts: { strict?: boolean } = {},
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (items.length === 0) return out;
  try {
    const { data: states, error } = await sb
      .from('content_keyword_item_state')
      .select('content_type, content_id, matched_rule_ids')
      .in('content_type', Array.from(new Set(items.map((i) => i.contentType))))
      .in('content_id', Array.from(new Set(items.map((i) => i.contentId))));
    if (error) {
      if (isMissingTable(error)) return out;
      if (opts.strict) throw new PoolQueryError('content_keyword_item_state', error);
      logQueryError('member matches', error);
      return out;
    }
    if (!Array.isArray(states)) return out;
    const ruleIds = new Set<string>();
    for (const s of states as Row[]) for (const id of (s.matched_rule_ids as string[] | null) ?? []) ruleIds.add(id);
    if (ruleIds.size === 0) return out;
    const { data: rules, error: rulesErr } = await sb
      .from('content_keyword_rules')
      .select('id, name, metadata')
      .in('id', Array.from(ruleIds));
    if (rulesErr) {
      if (isMissingTable(rulesErr)) return out;
      if (opts.strict) throw new PoolQueryError('content_keyword_rules', rulesErr);
      logQueryError('member rules', rulesErr);
      return out;
    }
    if (!Array.isArray(rules)) return out;
    const names = new Map<string, string>();
    for (const r of rules as Row[]) {
      const meta = (r.metadata ?? {}) as { kind?: unknown };
      if (meta.kind !== 'membership') continue;
      const name = memberDisplayName(r.name);
      if (name) names.set(String(r.id), name);
    }
    for (const s of states as Row[]) {
      const list = Array.from(new Set(((s.matched_rule_ids as string[] | null) ?? []).map((id) => names.get(id)).filter((n): n is string => !!n)));
      if (list.length) out.set(`${String(s.content_type)}::${String(s.content_id)}`, list.slice(0, 10));
    }
  } catch (e) {
    if (opts.strict) throw e;
    // Member mentions are optional: list and generate without them.
    logQueryError('member matches', e);
  }
  return out;
}

// ── list + load ─────────────────────────────────────────────────────────────

export interface ListPoolInput {
  types: PoolType[];
  search: string;
  limit: number;
}

export interface ListPoolResult {
  items: PoolItem[];
  /** Types whose table answered. A type whose module is not installed is left out. */
  available: PoolType[];
  /** Types whose table exists but whose query failed; the picker says so. */
  failed: PoolType[];
}

export async function listPool(sb: SupabaseLike, input: ListPoolInput, base = portalBase()): Promise<ListPoolResult> {
  const available: PoolType[] = [];
  const failed: PoolType[] = [];
  const results = await Promise.all(input.types.map(async (type) => {
    const a = ADAPTERS[type];
    try {
      let q = a.visible(sb.from(a.table).select(a.listColumns).eq('publish_state', 'published'));
      if (a.listScope) q = a.listScope(q);
      if (input.search) q = q.ilike(a.titleColumn, likePattern(input.search));
      const { data, error } = await q.order(a.orderColumn, { ascending: false, nullsFirst: false }).limit(input.limit);
      if (error) {
        // A missing table is a module that isn't installed: leave the type out.
        // Anything else is logged, and the rest of the pool still lists.
        if (!isMissingTable(error)) {
          logQueryError(`pool ${a.table}`, error);
          failed.push(type);
        }
        return [];
      }
      if (!Array.isArray(data)) return [];
      available.push(type);
      return (data as Row[]).map((r) => a.map(r, base));
    } catch (e) {
      logQueryError(`pool ${a.table}`, e);
      failed.push(type);
      return [];
    }
  }));
  const merged = results.flat()
    .sort((x, y) => (y.date ?? '').localeCompare(x.date ?? ''))
    .slice(0, input.limit);
  const members = await loadMembers(sb, merged);
  return {
    items: merged.map((i) => ({ ...i, body: null, members: members.get(`${i.contentType}::${i.contentId}`) ?? [] })),
    available: input.types.filter((t) => available.includes(t)),
    failed: input.types.filter((t) => failed.includes(t)),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ItemRef {
  content_type: PoolType;
  content_id: string;
}

/** Validate a client's item list: known types, uuid ids, no duplicates. */
export function parseItemRefs(raw: unknown, max: number): { ok: true; refs: ItemRef[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'items must be a non-empty array' };
  if (raw.length > max) return { ok: false, error: `at most ${max} items` };
  const refs: ItemRef[] = [];
  const seen = new Set<string>();
  for (const r of raw as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object' || !isPoolType(r.content_type) || typeof r.content_id !== 'string' || !UUID.test(r.content_id)) {
      return { ok: false, error: 'each item needs a known content_type and a uuid content_id' };
    }
    const key = `${r.content_type}::${r.content_id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ content_type: r.content_type, content_id: r.content_id.toLowerCase() });
  }
  return { ok: true, refs };
}

/**
 * Load the items a post is written from, in the order given, with bodies.
 * Only published items load: the client sends ids, never text, so a post can
 * only be written from content an editor approved.
 */
export async function loadItems(sb: SupabaseLike, refs: ItemRef[], base = portalBase(), opts: { strictMembers?: boolean } = {}): Promise<{ items: PoolItem[]; missing: ItemRef[] }> {
  const byType = new Map<PoolType, string[]>();
  for (const r of refs) byType.set(r.content_type, [...(byType.get(r.content_type) ?? []), r.content_id]);
  const found = new Map<string, Omit<PoolItem, 'members'>>();
  await Promise.all(Array.from(byType.entries()).map(async ([type, ids]) => {
    const a = ADAPTERS[type];
    const { data, error } = await a.visible(sb.from(a.table).select(a.loadColumns).eq('publish_state', 'published')).in('id', ids);
    if (error) {
      // Not installed: its refs come back as missing. A real failure must
      // not read as "no longer published", so it throws (the route sends 500).
      if (isMissingTable(error)) return;
      throw new PoolQueryError(a.table, error);
    }
    if (!Array.isArray(data)) return;
    for (const r of data as Row[]) {
      const item = a.map(r, base);
      found.set(`${type}::${item.contentId.toLowerCase()}`, item);
    }
  }));
  if (byType.has('sr_item')) await addRecapThemes(sb, found);
  const ordered = refs.map((r) => found.get(`${r.content_type}::${r.content_id}`)).filter((i): i is Omit<PoolItem, 'members'> => !!i);
  const members = await loadMembers(sb, ordered, { strict: opts.strictMembers });
  return {
    items: ordered.map((i) => ({ ...i, members: members.get(`${i.contentType}::${i.contentId}`) ?? [] })),
    missing: refs.filter((r) => !found.has(`${r.content_type}::${r.content_id}`)),
  };
}

/**
 * A conference recap resource carries little text itself; its themes live on
 * the conference-recap module's row. Add them to the body when that module is
 * installed.
 */
async function addRecapThemes(sb: SupabaseLike, found: Map<string, Omit<PoolItem, 'members'>>): Promise<void> {
  const srIds = Array.from(found.values()).filter((i) => i.contentType === 'sr_item').map((i) => i.contentId);
  if (srIds.length === 0) return;
  try {
    const { data, error } = await sb.from('conference_recaps').select('sr_item_id, event_name, themes').in('sr_item_id', srIds);
    if (error) {
      if (!isMissingTable(error)) logQueryError('conference recap themes', error);
      return;
    }
    if (!Array.isArray(data)) return;
    for (const r of data as Row[]) {
      const key = `sr_item::${String(r.sr_item_id).toLowerCase()}`;
      const item = found.get(key);
      if (!item) continue;
      const themes = Array.isArray(r.themes)
        ? (r.themes as Array<{ name?: unknown; blurb?: unknown; talk_ids?: unknown }>)
            .map((t) => {
              const talks = Array.isArray(t?.talk_ids) ? ` (${t.talk_ids.length} talks)` : '';
              return str(t?.name) ? `- ${String(t.name)}${talks}: ${str(t?.blurb) ?? ''}`.trim() : null;
            })
            .filter(Boolean)
        : [];
      found.set(key, {
        ...item,
        body: [str(r.event_name) ? `Event: ${String(r.event_name)}` : null, item.body, themes.length ? `Themes:\n${themes.join('\n')}` : null]
          .filter(Boolean).join('\n\n') || null,
      });
    }
  } catch (e) {
    // Themes only enrich the prompt; write the post without them.
    logQueryError('conference recap themes', e);
  }
}
