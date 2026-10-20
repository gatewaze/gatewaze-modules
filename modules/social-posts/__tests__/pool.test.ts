import { describe, expect, it } from 'vitest';
import {
  ADAPTERS,
  htmlToText,
  isMissingTable,
  loadMembers,
  likePattern,
  listPool,
  loadItems,
  memberDisplayName,
  parseItemRefs,
  portalBase,
  safeUrl,
} from '../lib/pool';

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';

/**
 * A minimal stand-in for the supabase-js query builder: records filters,
 * applies eq / in / ilike / gte over in-memory rows, and resolves like
 * PostgREST. A table missing from `tables` answers with an error.
 */
function fakeSupabase(tables: Record<string, Array<Record<string, unknown>>>, calls: string[] = []) {
  return {
    from(table: string) {
      const rows = tables[table];
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      let limit = Infinity;
      const q = {
        select() { return q; },
        eq(col: string, v: unknown) { filters.push((r) => r[col] === v); return q; },
        in(col: string, vs: unknown[]) { filters.push((r) => vs.includes(r[col])); return q; },
        gte(col: string, v: string) { filters.push((r) => String(r[col] ?? '') >= v); return q; },
        ilike(col: string, pattern: string) {
          calls.push(`ilike:${table}:${pattern}`);
          const needle = pattern.replace(/^%|%$/g, '').replace(/\\(.)/g, '$1').toLowerCase();
          filters.push((r) => String(r[col] ?? '').toLowerCase().includes(needle));
          return q;
        },
        order() { return q; },
        limit(n: number) { limit = n; return q; },
        then(resolve: (v: unknown) => void) {
          if (!rows) return resolve({ data: null, error: { message: `relation "${table}" does not exist` } });
          resolve({ data: rows.filter((r) => filters.every((f) => f(r))).slice(0, limit), error: null });
        },
      };
      return q;
    },
  };
}

describe('helpers', () => {
  it('safeUrl keeps http(s) only', () => {
    expect(safeUrl('https://aaif.io/blog/x/')).toBe('https://aaif.io/blog/x/');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('//evil.example')).toBeNull();
    expect(safeUrl('https://a b')).toBeNull();
    expect(safeUrl(null)).toBeNull();
  });
  it('portalBase reads SITE_URL then PORTAL_URL, and rejects non-http', () => {
    expect(portalBase({ SITE_URL: 'https://dev.aaif.live/' })).toBe('https://dev.aaif.live');
    expect(portalBase({ PORTAL_URL: 'https://p.example' })).toBe('https://p.example');
    expect(portalBase({ SITE_URL: 'ftp://x' })).toBeNull();
    expect(portalBase({})).toBeNull();
  });
  it('htmlToText drops tags, scripts and decodes entities', () => {
    expect(htmlToText('<p>Hello &amp; welcome</p><script>x()</script><p>Two&#39;s</p>')).toBe("Hello & welcome\nTwo's");
    expect(htmlToText('')).toBeNull();
  });
  it('memberDisplayName drops the rule prefix and legal suffixes', () => {
    expect(memberDisplayName('Member: Cisco Systems, Inc.')).toBe('Cisco Systems');
    expect(memberDisplayName('Member: Stripe, LLC')).toBe('Stripe');
    expect(memberDisplayName('Member: Infobip d.o.o')).toBe('Infobip');
    expect(memberDisplayName('Member: OpenAI Inc')).toBe('OpenAI');
    expect(memberDisplayName('Member: ')).toBeNull();
  });
  it('likePattern escapes wildcards and clamps', () => {
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
    expect(likePattern('x'.repeat(500)).length).toBe(102);
  });
  it('parseItemRefs validates types and ids, and dedupes', () => {
    expect(parseItemRefs([], 10).ok).toBe(false);
    expect(parseItemRefs([{ content_type: 'blog_post', content_id: 'nope' }], 10).ok).toBe(false);
    expect(parseItemRefs([{ content_type: 'people', content_id: ID1 }], 10).ok).toBe(false);
    expect(parseItemRefs(Array.from({ length: 11 }, () => ({ content_type: 'video', content_id: ID1 })), 10).ok).toBe(false);
    const r = parseItemRefs([{ content_type: 'video', content_id: ID1.toUpperCase() }, { content_type: 'video', content_id: ID1 }], 10);
    expect(r.ok && r.refs).toEqual([{ content_type: 'video', content_id: ID1 }]);
  });
});

describe('adapters', () => {
  it('blog post: canonical link, else a portal link; "Article" when external', () => {
    const ext = ADAPTERS.blog_post.map({ id: ID1, title: 'T', canonical_url: 'https://cncf.io/x', is_external: true, published_at: '2026-07-10T12:00:00Z' }, 'https://p.example');
    expect(ext).toMatchObject({ url: 'https://cncf.io/x', typeLabel: 'Article', date: '2026-07-10' });
    const own = ADAPTERS.blog_post.map({ id: ID1, title: 'T', slug: 'hello world', canonical_url: null }, 'https://p.example');
    expect(own.url).toBe('https://p.example/blog/hello%20world');
    expect(ADAPTERS.blog_post.map({ id: ID1, title: 'T', slug: 's' }, null).url).toBeNull();
  });
  it('event: registration link, location, upcoming scope', () => {
    const e = ADAPTERS.event.map({ id: ID1, event_title: 'AgentCon', event_link: 'https://luma.com/x', event_start: '2026-11-03T09:00:00Z', event_city: 'Berlin', event_country_code: 'DE' }, null);
    expect(e).toMatchObject({ title: 'AgentCon', url: 'https://luma.com/x', date: '2026-11-03', location: 'Berlin, DE' });
    expect(e.body).toContain('Starts: 2026-11-03T09:00:00Z');
  });
  it('resource: collection name as the type label and a portal link', () => {
    const r = ADAPTERS.sr_item.map({ id: ID1, title: 'Mumbai 2026', slug: 'mumbai-2026', collection: { name: 'Conference Recap', slug: 'conference-recap' } }, 'https://dev.aaif.live');
    expect(r).toMatchObject({ typeLabel: 'Conference Recap', url: 'https://dev.aaif.live/resources/conference-recap/mumbai-2026' });
  });
  it('video: speakers go into the body', () => {
    const v = ADAPTERS.video.map({ id: ID1, title: 'Talk', url: 'https://youtu.be/x', speakers: [{ name: 'Ada', org: 'Acme' }], description: 'About it' }, null);
    expect(v.body).toBe('Speakers: Ada, Acme\n\nAbout it');
  });
});

const tables = () => ({
  blog_posts: [
    { id: ID1, title: 'Introducing the MCPA', canonical_url: 'https://aaif.io/blog/mcpa/', published_at: '2026-07-10T00:00:00Z', publish_state: 'published', status: 'published', visibility: 'public', content: '<p>Body</p>' },
    { id: ID2, title: 'Pending post', canonical_url: 'https://aaif.io/blog/p/', published_at: '2026-07-11T00:00:00Z', publish_state: 'pending_review', status: 'pending_review', visibility: 'public' },
    // An admin's draft: publish_state defaults to 'published' without the Inbox.
    { id: '44444444-4444-4444-8444-444444444444', title: 'Admin draft', published_at: '2026-07-12T00:00:00Z', publish_state: 'published', status: 'draft', visibility: 'public' },
    { id: '55555555-5555-4555-8555-555555555555', title: 'Private post', published_at: '2026-07-13T00:00:00Z', publish_state: 'published', status: 'published', visibility: 'private' },
  ],
  videos: [
    { id: ID3, title: 'Keynote', url: 'https://youtu.be/k', published_at: '2026-08-01T00:00:00Z', publish_state: 'published', status: 'published', visibility: 'public' },
  ],
  content_keyword_item_state: [
    { content_type: 'blog_post', content_id: ID1, matched_rule_ids: ['r1', 'r2', 'r3'] },
  ],
  content_keyword_rules: [
    { id: 'r1', name: 'Member: Cisco Systems, Inc.', metadata: { kind: 'membership' } },
    { id: 'r2', name: 'MCP', metadata: {} },
    { id: 'r3', name: 'Member: Google LLC', metadata: { kind: 'membership' } },
  ],
});

describe('listPool', () => {
  it('lists published items only, newest first, with members, and reports available types', async () => {
    const r = await listPool(fakeSupabase(tables()) as never, { types: ['blog_post', 'video', 'event'], search: '', limit: 10 }, null);
    expect(r.items.map((i) => i.title)).toEqual(['Keynote', 'Introducing the MCPA']);
    expect(r.items[1].members).toEqual(['Cisco Systems', 'Google']);
    expect(r.items.every((i) => i.body === null)).toBe(true);
    // events has no table in this fake, so it is left out rather than failing the list.
    expect(r.available).toEqual(['blog_post', 'video']);
  });
  it('passes an escaped search through', async () => {
    const calls: string[] = [];
    await listPool(fakeSupabase(tables(), calls) as never, { types: ['blog_post'], search: '100%', limit: 10 }, null);
    expect(calls).toEqual(['ilike:blog_posts:%100\\%%']);
  });
  it('still lists when content-keywords is absent', async () => {
    const t: Record<string, Array<Record<string, unknown>>> = tables();
    delete t.content_keyword_item_state;
    const r = await listPool(fakeSupabase(t) as never, { types: ['blog_post'], search: '', limit: 10 }, null);
    expect(r.items[0].members).toEqual([]);
  });
});

describe('loadItems', () => {
  it('loads in the order given, with bodies, and reports unpublished or unknown ids as missing', async () => {
    const r = await loadItems(fakeSupabase(tables()) as never, [
      { content_type: 'video', content_id: ID3 },
      { content_type: 'blog_post', content_id: ID1 },
      { content_type: 'blog_post', content_id: ID2 },
      { content_type: 'blog_post', content_id: '44444444-4444-4444-8444-444444444444' },
      { content_type: 'event', content_id: ID1 },
    ], null);
    expect(r.items.map((i) => i.contentId)).toEqual([ID3, ID1]);
    expect(r.items[1].body).toBe('Body');
    expect(r.items[1].members).toEqual(['Cisco Systems', 'Google']);
    expect(r.missing).toEqual([
      { content_type: 'blog_post', content_id: ID2 },
      { content_type: 'blog_post', content_id: '44444444-4444-4444-8444-444444444444' },
      { content_type: 'event', content_id: ID1 },
    ]);
  });
  it('adds conference recap themes to a resource', async () => {
    const r = await loadItems(fakeSupabase({
      sr_items: [{ id: ID1, title: 'Mumbai 2026', subtitle: '55 talks', publish_state: 'published', status: 'published', collection: { name: 'Conference Recap', slug: 'conference-recap' } }],
      conference_recaps: [{ sr_item_id: ID1, event_name: 'MCP Dev Summit Mumbai 2026', themes: [{ name: 'Security and identity', blurb: 'Securing MCP agents.', talk_ids: ['a', 'b'] }] }],
    }) as never, [{ content_type: 'sr_item', content_id: ID1 }], null);
    expect(r.items[0].body).toContain('Event: MCP Dev Summit Mumbai 2026');
    expect(r.items[0].body).toContain('- Security and identity (2 talks): Securing MCP agents.');
  });
});

describe('a real query error', () => {
  it('lists the other types and reports the failed one', async () => {
    const sb = fakeSupabase(tables());
    const from = sb.from.bind(sb);
    const failingBuilder: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'in', 'gte', 'ilike', 'order', 'limit']) failingBuilder[k] = () => failingBuilder;
    failingBuilder.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { code: '57014', message: 'timeout' } });
    const r = await listPool({ from: (t: string) => (t === 'blog_posts' ? failingBuilder : from(t)) } as never, { types: ['blog_post', 'video'], search: '', limit: 10 }, null);
    expect(r.items.map((i) => i.title)).toEqual(['Keynote']);
    expect(r.available).toEqual(['video']);
    expect(r.failed).toEqual(['blog_post']);
  });
  it('loadMembers throws in strict mode and degrades otherwise', async () => {
    const failingBuilder: Record<string, unknown> = {};
    for (const k of ['select', 'in']) failingBuilder[k] = () => failingBuilder;
    failingBuilder.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { code: '57014', message: 'timeout' } });
    const sb = { from: () => failingBuilder } as never;
    const ref = [{ contentType: 'blog_post' as const, contentId: ID1 }];
    expect((await loadMembers(sb, ref)).size).toBe(0);
    await expect(loadMembers(sb, ref, { strict: true })).rejects.toThrow(/content_keyword_item_state/);
  });
});

describe('isMissingTable', () => {
  it('tells a missing table from a real failure', () => {
    expect(isMissingTable({ code: '42P01', message: 'relation "x" does not exist' })).toBe(true);
    expect(isMissingTable({ code: 'PGRST205', message: "Could not find the table 'public.x' in the schema cache" })).toBe(true);
    expect(isMissingTable({ code: '57014', message: 'statement timeout' })).toBe(false);
    expect(isMissingTable(null)).toBe(false);
  });
});

describe('events window', () => {
  it('lists upcoming and recent events, not old ones', async () => {
    const day = 86_400_000;
    const r = await listPool(fakeSupabase({
      events: [
        { id: ID1, event_title: 'Old', event_start: new Date(Date.now() - 100 * day).toISOString(), publish_state: 'published', is_listed: true },
        { id: ID2, event_title: 'AgentCon', event_start: new Date(Date.now() + 10 * day).toISOString(), publish_state: 'published', is_listed: true },
        { id: ID3, event_title: 'Unlisted', event_start: new Date(Date.now() + 10 * day).toISOString(), publish_state: 'published', is_listed: false },
      ],
    }) as never, { types: ['event'], search: '', limit: 10 }, null);
    expect(r.items.map((i) => i.title)).toEqual(['AgentCon']);
  });
});
