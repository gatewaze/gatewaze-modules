/**
 * Supabase-backed LfxDataProvider. Reads the tables the AAIF brand
 * already populates:
 *
 *   member_organizations + membership_tier_ranks  (lf membership module)
 *   events                                        (events module)
 *   blog_posts + blog_authors                     (blog module)
 *
 * Every query is a plain `.eq()` / `.in()` chain — no `.or()` filter
 * strings are built from input. Logo URLs stored with the in-cluster
 * Supabase host are rewritten to the public host so they load in a
 * browser (and on a published static site).
 */

import type { LfxDataProvider, LfxEventRow, LfxMemberRow, LfxPostRow, LfxTierGroup } from './types.js';

export interface LfxDataSupabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

export interface LfxDataProviderOptions {
  /** Rewrites storage URLs for the browser (internal host → public host). */
  rewriteUrl?: (url: string) => string;
  /** Base path or origin for blog posts without a canonical_url. */
  blogBase?: string;
  /** Tiers never listed on the site (the host foundation itself). */
  hiddenTiers?: string[];
  now?: () => Date;
}

interface MemberOrgRow {
  name: string;
  tier: string;
  tier_rank: number;
  logo_url: string | null;
  website_url: string | null;
  is_public: boolean | null;
}

interface TierRankRow {
  tier: string;
  rank: number;
  display_label: string;
}

interface EventRow {
  event_title: string;
  event_start: string;
  event_city: string | null;
  event_country_code: string | null;
  event_link: string | null;
  event_timezone: string | null;
}

interface BlogPostRow {
  title: string;
  slug: string | null;
  excerpt: string | null;
  published_at: string | null;
  canonical_url: string | null;
  blog_author_id: string | null;
}

function formatDate(iso: string | null, timeZone?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: timeZone || 'UTC' });
  } catch {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }
}

function safeHttp(url: string | null | undefined): string {
  const s = (url ?? '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

export function createSupabaseLfxDataProvider(
  supabase: LfxDataSupabase,
  opts: LfxDataProviderOptions = {},
): LfxDataProvider {
  const rewrite = opts.rewriteUrl ?? ((u: string) => u);
  const hidden = new Set(opts.hiddenTiers ?? ['foundation']);
  const blogBase = (opts.blogBase ?? '/blog').replace(/\/+$/, '');
  const now = opts.now ?? (() => new Date());

  async function tierRanks(): Promise<TierRankRow[]> {
    const res = await supabase.from('membership_tier_ranks').select('tier, rank, display_label').order('rank', { ascending: false });
    if (res.error) throw new Error(`membership_tier_ranks: ${res.error.message}`);
    return (res.data as TierRankRow[]) ?? [];
  }

  async function activeMembers(tiers?: string[]): Promise<MemberOrgRow[]> {
    let q = supabase
      .from('member_organizations')
      .select('name, tier, tier_rank, logo_url, website_url, is_public')
      .eq('is_active', true)
      .order('tier_rank', { ascending: false })
      .order('name', { ascending: true });
    if (tiers && tiers.length > 0) q = q.in('tier', tiers);
    const res = await q;
    if (res.error) throw new Error(`member_organizations: ${res.error.message}`);
    return ((res.data as MemberOrgRow[]) ?? []).filter((m) => m.is_public !== false && !hidden.has(m.tier));
  }

  const toLogoRow = (m: MemberOrgRow) => ({
    name: m.name,
    logo_url: safeHttp(m.logo_url ? rewrite(m.logo_url) : ''),
    website_url: safeHttp(m.website_url),
  });

  return {
    async members({ limit, tiers }): Promise<LfxMemberRow[]> {
      const [ranks, rows] = await Promise.all([tierRanks(), activeMembers(tiers)]);
      const label = new Map(ranks.map((r) => [r.tier, r.display_label]));
      const sliced = typeof limit === 'number' && limit > 0 ? rows.slice(0, limit) : rows;
      return sliced.map((m) => ({ ...toLogoRow(m), tier: m.tier, tier_label: label.get(m.tier) ?? m.tier }));
    },

    async memberTiers(): Promise<LfxTierGroup[]> {
      const [ranks, rows] = await Promise.all([tierRanks(), activeMembers()]);
      const groups: LfxTierGroup[] = [];
      let i = 0;
      for (const r of ranks) {
        if (hidden.has(r.tier)) continue;
        const members = rows.filter((m) => m.tier === r.tier).map(toLogoRow);
        if (members.length === 0) continue;
        groups.push({ name: r.display_label, mist: i % 2 === 1, members });
        i++;
      }
      return groups;
    },

    async upcomingEvents(limit): Promise<LfxEventRow[]> {
      const res = await supabase
        .from('events')
        .select('event_title, event_start, event_city, event_country_code, event_link, event_timezone')
        .eq('is_listed', true)
        .gte('event_start', now().toISOString())
        .order('event_start', { ascending: true })
        .limit(limit);
      if (res.error) throw new Error(`events: ${res.error.message}`);
      return ((res.data as EventRow[]) ?? []).map((e) => ({
        name: e.event_title,
        date: formatDate(e.event_start, e.event_timezone),
        location: e.event_city
          ? [e.event_city, e.event_country_code ? e.event_country_code.toUpperCase() : ''].filter(Boolean).join(', ')
          : 'Virtual',
        url: safeHttp(e.event_link),
      }));
    },

    async latestPosts(limit): Promise<LfxPostRow[]> {
      const res = await supabase
        .from('blog_posts')
        .select('title, slug, excerpt, published_at, canonical_url, blog_author_id')
        .eq('status', 'published')
        .order('published_at', { ascending: false })
        .limit(limit);
      if (res.error) throw new Error(`blog_posts: ${res.error.message}`);
      const posts = ((res.data as BlogPostRow[]) ?? []);
      const authorIds = [...new Set(posts.map((p) => p.blog_author_id).filter((x): x is string => !!x))];
      const authors = new Map<string, string>();
      if (authorIds.length > 0) {
        const a = await supabase.from('blog_authors').select('id, display_name').in('id', authorIds);
        for (const row of ((a.data as Array<{ id: string; display_name: string }> | null) ?? [])) {
          authors.set(row.id, row.display_name);
        }
      }
      return posts.map((p) => ({
        title: p.title,
        date: formatDate(p.published_at),
        author: p.blog_author_id ? (authors.get(p.blog_author_id) ?? '') : '',
        excerpt: (p.excerpt ?? '').trim(),
        url: safeHttp(p.canonical_url) || (p.slug ? `${blogBase}/${encodeURIComponent(p.slug)}` : ''),
      }));
    },
  };
}
